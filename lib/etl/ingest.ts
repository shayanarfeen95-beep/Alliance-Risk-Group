import 'server-only';
import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getConnector, CONNECTORS, type SourceSystemCode } from '@/lib/connectors';
import { conformBatch } from './conform';

/**
 * Running a load.
 *
 * There is exactly one of these, and both callers go through it: the assistant's
 * preview-then-confirm flow, and the Sync button in Admin. §1 is explicit that
 * there must be no second, weaker ingestion path — a load started from a button
 * and a load started from a conversation must produce the same `load_run`, the
 * same provenance and the same reconciliation, or the audit trail describes two
 * different systems.
 *
 * What differs between the two is only *authorisation shape*: the assistant
 * writes a PREVIEW row first and waits for a human to click; the Sync button is
 * itself the human clicking. Both end here.
 */

export interface LoadOutcome {
  source: SourceSystemCode;
  entity: string;
  ok: boolean;
  loadRunId: string;
  recordsRead: number;
  rowsWritten: number;
  /** Things the operator must know — months skipped, entities not conformed. */
  notes: string[];
  error?: string;
  /**
   * False when the source had more to give and the slice ran out of budget.
   *
   * The run stays RUNNING and keeps its cursor; call again with the same
   * `loadRunId` to continue. An unfinished slice is not a failure — every record
   * it read is landed and conformed — so `ok` and `done` are separate answers.
   */
  done: boolean;
  /** How many slices this run has taken so far, unfinished ones included. */
  slices: number;
}

/** What one slice is allowed to spend before handing back a cursor. */
export interface SliceBudget {
  deadline?: number;
  maxRecords?: number;
  /**
   * Ignore the watermark and read the source from the beginning.
   *
   * For the case where the warehouse and the source have genuinely diverged —
   * a mapping changed, a conform bug was fixed, somebody edited history in the
   * provider. Never the default: it is the expensive path, and the whole reason
   * the watermark exists is that it was previously the ONLY path.
   */
  fullRefresh?: boolean;
}

/** Where a run is resuming from, kept on `load_run.plan`. */
interface RunPlan {
  startedFrom?: string;
  cursor?: string | null;
  slices?: number;
  /** Newest source-side change seen so far in this run, across all its slices. */
  watermark?: string | null;
}

/** The later of what the run has already seen and what this slice just saw. */
function highWatermark(plan: RunPlan, fromBatch: Date | null): Date | null {
  const carried = plan.watermark ? new Date(plan.watermark) : null;
  if (!carried) return fromBatch;
  if (!fromBatch) return carried;
  return fromBatch > carried ? fromBatch : carried;
}

async function readWatermark(
  db: Database,
  source: SourceSystemCode,
  entity: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ watermark: t.syncState.watermark })
    .from(t.syncState)
    .where(and(eq(t.syncState.sourceSystem, source), eq(t.syncState.entity, entity)))
    .limit(1);
  return row?.watermark ?? null;
}

async function advanceWatermark(
  db: Database,
  source: SourceSystemCode,
  entity: string,
  watermark: Date | null,
  recordCount: number,
): Promise<void> {
  const row = {
    sourceSystem: source,
    entity,
    watermark,
    lastSyncedAt: new Date(),
    lastRecordCount: recordCount,
  };

  await db
    .insert(t.syncState)
    .values(row)
    .onConflictDoUpdate({
      target: [t.syncState.sourceSystem, t.syncState.entity],
      set: row,
    });
}

/** Clears the watermarks, so the next pull reads the source from the beginning. */
export async function resetWatermarks(
  db: Database,
  sources?: SourceSystemCode[],
): Promise<void> {
  if (sources?.length) {
    for (const source of sources) {
      await db.delete(t.syncState).where(eq(t.syncState.sourceSystem, source));
    }
    return;
  }
  await db.delete(t.syncState);
}

/**
 * How long one slice may spend fetching.
 *
 * The route is capped at 60 seconds by the platform. Fetching has to stop well
 * before that, because landing and conforming what was fetched still has to
 * happen inside the same invocation — and a slice killed mid-conform is the one
 * outcome with no useful answer for the operator.
 */
export const SLICE_FETCH_BUDGET_MS = 20_000;

/**
 * How many records one slice may carry into conform.
 *
 * Fetching a thousand HubSpot deals takes about five seconds; upserting them,
 * each with its stage history rewritten, takes considerably longer against a
 * pooled Postgres over the network. This is the number that keeps the write half
 * of a slice inside the invocation, and it is the reason a time budget alone was
 * not enough.
 */
export const SLICE_MAX_RECORDS = 1_000;

/**
 * The only entities whose raw payloads are kept.
 *
 * Keyed `SOURCE:entity`. HubSpot owners are here because conform's
 * `ownerNameMap` reads them back to put a salesperson's name on a deal; there is
 * no second reader anywhere in this codebase. Adding an entity here is a
 * commitment to store every record of it on every pull, forever, so it needs a
 * reader to justify it.
 */
export const LANDS_RAW = new Set(['HUBSPOT:owners']);

/**
 * How long a landed payload is kept.
 *
 * Even the entities that are read do not need their history: the owner lookup
 * wants the current owners, not every version of them a pull has ever seen. A
 * sweep after each completed entity keeps the table proportional to the source
 * rather than to the number of times anybody has pressed Pull.
 */
export const RAW_RETENTION_DAYS = 30;

/**
 * Executes one load run that is already recorded and RUNNING.
 *
 * Split out so the caller owns how the run came to exist — confirmed from a
 * preview, or created directly by a sync — while the work itself, and the
 * provenance it writes, stay identical.
 */
export async function executeLoadRun(
  db: Database,
  user: SessionUser,
  run: { id: string; sourceSystem: string; entity: string; windowStart: string | null; windowEnd: string | null; plan?: unknown },
  auditAction: string,
  options: SliceBudget & {
    /** Set when this slice is picking up a pull that stopped earlier. */
    continuation?: boolean;
  } = {},
): Promise<LoadOutcome> {
  const connector = getConnector(run.sourceSystem as SourceSystemCode);
  const priorPlan = (run.plan ?? {}) as RunPlan;
  const slices = (priorPlan.slices ?? 0) + 1;

  // Where the last completed pass got to. A resuming slice must not re-read it
  // from the table — the run already carries its own position, and re-reading
  // would restart the entity mid-pull.
  const since = options.fullRefresh
    ? null
    : slices > 1
      ? null
      : await readWatermark(db, run.sourceSystem as SourceSystemCode, run.entity);

  const base = {
    source: run.sourceSystem as SourceSystemCode,
    entity: run.entity,
    loadRunId: run.id,
    recordsRead: 0,
    rowsWritten: 0,
    notes: [] as string[],
    slices,
  };

  try {
    const batch = await connector.fetch(
      run.entity,
      { start: run.windowStart!, end: run.windowEnd! },
      {
        cursor: priorPlan.cursor ?? null,
        deadline: options.deadline ?? Date.now() + SLICE_FETCH_BUDGET_MS,
        maxRecords: options.maxRecords ?? SLICE_MAX_RECORDS,
        since,
      },
    );

    // Raw landing, for the entities something actually reads.
    //
    // This used to store every record from every pull, on the stated principle
    // that conform could then be re-run without re-hitting the API. Nothing ever
    // implemented that: the only reader of raw_payload in this codebase is the
    // owner-name lookup in conform. So sixty-four thousand contact payloads,
    // each carrying full lifecycle history, were being written and kept for
    // nothing — twice over, once per pull — and it filled the database.
    //
    // Owners are landed because they are genuinely read. Everything else goes
    // straight to conform, which is where it was going anyway.
    if (LANDS_RAW.has(`${batch.sourceSystem}:${run.entity}`)) {
      for (let i = 0; i < batch.records.length; i += 200) {
        await db.insert(t.rawPayload).values(
          batch.records.slice(i, i + 200).map((record) => ({
            loadRunId: run.id,
            sourceSystem: batch.sourceSystem,
            entity: record.entity,
            payload: record.payload as object,
          })),
        );
      }
    }

    // Then conform, in the same run. Landing data and stopping was the gap that
    // let a connected source and a seeded dashboard coexist with nothing
    // anywhere saying the two were unrelated.
    const conformed = await conformBatch(db, run.id, batch);

    // Say so when a pull is continuing rather than starting over. Without this
    // a resumed pull and a restarted one look identical from the outside, which
    // is exactly the doubt this whole mechanism exists to remove.
    const notes = [...conformed.notes];
    if (options.continuation) {
      notes.unshift('Continued from where the last pull stopped, rather than starting again.');
    }
    if (slices === 1 && !priorPlan.cursor && since) {
      notes.unshift(
        `Only what changed since ${since.toISOString().slice(0, 16).replace('T', ' ')} was fetched.`,
      );
    }

    const done = !batch.nextCursor;

    // The watermark moves only when the entity finishes.
    //
    // A run that stops halfway — budget spent, network lost, deploy mid-pull —
    // leaves it where it was, so whatever this pass did not reach is fetched
    // again next time. Advancing it per slice would be faster and would lose
    // records permanently the first time a slice failed, which is the one
    // outcome nobody would notice.
    if (done) {
      await sweepRawPayloads(db);
      await advanceWatermark(
        db,
        run.sourceSystem as SourceSystemCode,
        run.entity,
        highWatermark(priorPlan, batch.watermark ?? null),
        batch.records.length,
      );
    }

    // Slices accumulate onto the run rather than replacing it: one entity is one
    // load_run however many requests it took, so provenance still points at a
    // single row and the audit trail does not fragment by network conditions.
    await db
      .update(t.loadRun)
      .set({
        status: done ? 'SUCCEEDED' : 'RUNNING',
        rowsRead: sql`${t.loadRun.rowsRead} + ${batch.records.length}`,
        rowsWritten: sql`${t.loadRun.rowsWritten} + ${conformed.rowsWritten}`,
        finishedAt: done ? new Date() : null,
        plan: {
          ...priorPlan,
          cursor: batch.nextCursor ?? null,
          slices,
          // Carried across slices so the finishing one can commit the newest
          // timestamp the whole run saw, not just the newest in its own page.
          watermark: highWatermark(priorPlan, batch.watermark ?? null)?.toISOString() ?? null,
        },
      })
      .where(eq(t.loadRun.id, run.id));

    // Only the finishing slice writes the audit event. One row per entity pulled
    // is what an auditor expects to read; one row per network round trip is not.
    if (done) {
      // Read the accumulated totals back rather than reporting this slice's, so
      // the audit row describes the whole entity however many slices it took.
      const [totals] = await db
        .select({ rowsRead: t.loadRun.rowsRead, rowsWritten: t.loadRun.rowsWritten })
        .from(t.loadRun)
        .where(eq(t.loadRun.id, run.id))
        .limit(1);

      await db.insert(t.auditEvent).values({
        userId: user.id,
        action: auditAction,
        entity: 'load_run',
        entityId: run.id,
        detail: {
          source: run.sourceSystem,
          entity: run.entity,
          records: totals?.rowsRead ?? batch.records.length,
          rowsWritten: totals?.rowsWritten ?? conformed.rowsWritten,
          slices,
          notes,
        },
      });
    }

    return {
      ...base,
      ok: true,
      done,
      recordsRead: batch.records.length,
      rowsWritten: conformed.rowsWritten,
      notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(t.loadRun)
      .set({ status: 'FAILED', errorMessage: message, finishedAt: new Date() })
      .where(eq(t.loadRun.id, run.id));

    return { ...base, ok: false, done: true, error: message };
  }
}

/**
 * Continues a run that stopped on a budget rather than at the end of its data.
 *
 * Refuses to touch a run that already finished or failed: resuming a SUCCEEDED
 * run would re-land records the warehouse already holds under a run that has
 * been reported as complete.
 */
export async function resumeLoadRun(
  db: Database,
  user: SessionUser,
  loadRunId: string,
  options: SliceBudget = {},
): Promise<LoadOutcome> {
  if (!can(user, 'RUN_INGESTION')) {
    throw new Error('You are not permitted to run ingestion.');
  }

  const [run] = await db.select().from(t.loadRun).where(eq(t.loadRun.id, loadRunId)).limit(1);
  if (!run) throw new Error('That load run no longer exists.');
  if (run.status !== 'RUNNING') {
    throw new Error(`That load run is ${run.status.toLowerCase()}, so there is nothing to resume.`);
  }

  return executeLoadRun(db, user, run, 'SOURCE_SYNCED', options);
}

/**
 * A load started directly, without a preview.
 *
 * The Sync button in Admin. The click *is* the confirmation, so there is no
 * PREVIEW step — but the run is recorded, reversible and reconciled exactly as
 * an agent-initiated one.
 */
export async function runLoad(
  db: Database,
  user: SessionUser,
  input: { source: SourceSystemCode; entity: string; windowStart: string; windowEnd: string },
  options: SliceBudget = {},
): Promise<LoadOutcome> {
  const connector = getConnector(input.source);

  if (!(await connector.isConfigured())) {
    return {
      source: input.source,
      entity: input.entity,
      ok: false,
      loadRunId: '',
      recordsRead: 0,
      rowsWritten: 0,
      notes: [],
      done: true,
      slices: 0,
      error: `${connector.label} is not connected, so nothing was fetched.`,
    };
  }

  // An entity that did not finish last time is CONTINUED, not restarted.
  //
  // This is the difference between a sync that converges and one that never
  // does. HubSpot caps a page at fifty objects when property history is asked
  // for, so sixty thousand contacts is over a thousand round trips — long
  // enough that a pull is routinely interrupted by a closed tab or a lost
  // connection. The watermark only moves when an entity completes, so an
  // interrupted pass left nothing behind and the next pull began again at zero.
  // Forever, for the one entity big enough to need this most.
  //
  // The position was already being kept, on the run — it was simply thrown away
  // when a new run started. Now the newest unfinished run for this entity hands
  // its cursor over.
  if (!options.fullRefresh) {
    const resumable = await unfinishedRun(db, input.source, input.entity);

    // Still RUNNING: continue it, so one pass over an entity stays one run and
    // the row counts keep accumulating rather than fragmenting per attempt.
    if (resumable?.status === 'RUNNING') {
      return executeLoadRun(db, user, resumable, 'SOURCE_SYNCED', {
        ...options,
        continuation: true,
      });
    }

    // Failed partway: its run is closed, but the position it reached is good —
    // everything before it was landed and conformed. Carry it into a new run.
    if (resumable?.plan) {
      const cursor = (resumable.plan as RunPlan).cursor;
      if (cursor) {
        return startRun(db, user, input, options, {
          cursor,
          watermark: (resumable.plan as RunPlan).watermark ?? null,
          resumedFrom: resumable.id,
        });
      }
    }
  }

  return startRun(db, user, input, options, null);
}

async function startRun(
  db: Database,
  user: SessionUser,
  input: { source: SourceSystemCode; entity: string; windowStart: string; windowEnd: string },
  options: SliceBudget,
  resume: { cursor: string; watermark: string | null; resumedFrom: string } | null,
): Promise<LoadOutcome> {
  // Closed months do not change, and conform refuses to write them anyway — so
  // fetching them is a report call per month for a result that is discarded.
  // The window starts at the first month still open.
  const windowStart = options.fullRefresh
    ? input.windowStart
    : await firstOpenMonth(db, input.windowStart, input.windowEnd);

  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem: input.source,
      entity: input.entity,
      windowStart,
      windowEnd: input.windowEnd,
      status: 'RUNNING',
      requestedByUserId: user.id,
      confirmedAt: new Date(),
      plan: {
        startedFrom: 'admin_sync',
        ...(resume
          ? { cursor: resume.cursor, watermark: resume.watermark, resumedFrom: resume.resumedFrom }
          : {}),
      },
    })
    .returning();

  return executeLoadRun(db, user, run!, 'SOURCE_SYNCED', {
    ...options,
    continuation: resume !== null,
  });
}

/**
 * The newest run for this entity that stopped before it was finished.
 *
 * RUNNING means a pass is genuinely still open — the browser went away
 * mid-pull. FAILED with a cursor means a pass died partway; everything before
 * the cursor was landed and conformed, so the position is still good even
 * though the run is not.
 */
async function unfinishedRun(
  db: Database,
  source: SourceSystemCode,
  entity: string,
): Promise<{ id: string; sourceSystem: string; entity: string; windowStart: string | null; windowEnd: string | null; plan: unknown; status: string } | null> {
  const [row] = await db
    .select()
    .from(t.loadRun)
    .where(
      and(
        eq(t.loadRun.sourceSystem, source),
        eq(t.loadRun.entity, entity),
        inArray(t.loadRun.status, ['RUNNING', 'FAILED']),
      ),
    )
    .orderBy(desc(t.loadRun.startedAt))
    .limit(1);

  if (!row) return null;
  // A failed run with no cursor has nothing to offer; starting fresh is right.
  if (row.status === 'FAILED' && !(row.plan as RunPlan | null)?.cursor) return null;
  return row;
}



/**
 * Deletes landed payloads that nothing will read again.
 *
 * Two rules: anything from an entity that is no longer landed at all, and
 * anything older than the retention window. Both are safe because the single
 * reader — the owner-name lookup — wants the current owners, and a pull that
 * needs owners has just landed them.
 *
 * Failures are swallowed. Reclaiming space is housekeeping; a pull that
 * succeeded must not be reported as failed because the sweep could not run.
 */
async function sweepRawPayloads(db: Database): Promise<void> {
  const cutoff = new Date(Date.now() - RAW_RETENTION_DAYS * 86_400_000);
  try {
    await db.delete(t.rawPayload).where(lt(t.rawPayload.fetchedAt, cutoff));
  } catch {
    // Housekeeping only.
  }
}

/**
 * Removes every landed payload that no code path reads.
 *
 * The one-time counterpart to the sweep: the space already consumed by pulls
 * made before landing became selective. Returns what it removed so the operator
 * sees the reclaim rather than being told it happened.
 */
export async function reclaimRawPayloads(
  db: Database,
): Promise<{ deleted: number; kept: number }> {
  const rows = await db
    .select({ sourceSystem: t.rawPayload.sourceSystem, entity: t.rawPayload.entity })
    .from(t.rawPayload);

  // The stored `entity` is the connector's own path — `/crm/v3/owners` — rather
  // than the entity name, so keeping is decided on what the reader looks for.
  const keep = (entity: string) => entity.includes('owners');

  const deletable = [...new Set(rows.map((row) => row.entity).filter((e) => !keep(e)))];
  if (deletable.length === 0) {
    return { deleted: 0, kept: rows.length };
  }

  await db.delete(t.rawPayload).where(inArray(t.rawPayload.entity, deletable));

  const deleted = rows.filter((row) => !keep(row.entity)).length;
  return { deleted, kept: rows.length - deleted };
}

/**
 * The first month in the window that is still open.
 *
 * A closed month is frozen: conform refuses to write it, and the reconciliation
 * that proves it has already run. Fetching it produces a report call per month
 * whose result is thrown away. If every month in the window is closed the window
 * is left alone rather than collapsing to nothing — an empty window would read
 * as "this source has no data" rather than "there was nothing to refresh".
 */
async function firstOpenMonth(
  db: Database,
  windowStart: string,
  windowEnd: string,
): Promise<string> {
  const rows = await db
    .select({ periodMonth: t.dimPeriod.periodMonth, isClosed: t.dimPeriod.isClosed })
    .from(t.dimPeriod)
    .where(and(gte(t.dimPeriod.periodMonth, windowStart), lte(t.dimPeriod.periodMonth, windowEnd)))
    .orderBy(t.dimPeriod.periodMonth);

  const open = rows.find((row) => !row.isClosed);
  return open?.periodMonth ?? windowStart;
}

/**
 * Every entity of every connected source, in one pass.
 *
 * Entities are pulled in sequence rather than in parallel. QuickBooks and
 * HubSpot both rate limit aggressively, and a refresh that trips a 429 halfway
 * through leaves the warehouse holding half a month — which looks like a real
 * decline in revenue rather than a failed load.
 *
 * This runs the whole plan inside one call, so it belongs anywhere with an
 * unbounded budget — a scheduled refresh, a script, a test. It is *not* what the
 * Pull button uses: fourteen entities of live data do not fit in a serverless
 * invocation, and trying was what made the button return nothing at all. That
 * path drives `syncPlan` and `runSlice` one slice at a time instead.
 */
export async function syncAll(
  db: Database,
  user: SessionUser,
  input: { windowStart: string; windowEnd: string; sources?: SourceSystemCode[] },
): Promise<LoadOutcome[]> {
  const steps = await syncPlan(input.sources);
  if (!can(user, 'RUN_INGESTION')) {
    throw new Error('You are not permitted to run ingestion.');
  }

  const outcomes: LoadOutcome[] = [];

  for (const step of steps) {
    let outcome = await runLoad(db, user, {
      source: step.source,
      entity: step.entity,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    });

    // Keep going until the source says it has no more, so a caller with the
    // budget for it still gets a complete pull out of a sliced connector.
    while (outcome.ok && !outcome.done) {
      outcome = await resumeLoadRun(db, user, outcome.loadRunId);
    }

    outcomes.push(outcome);
  }

  return outcomes;
}

/** One unit of work in a pull: an entity of a connected source. */
export interface SyncStep {
  source: SourceSystemCode;
  sourceLabel: string;
  entity: string;
  label: string;
}

/**
 * What a pull would consist of, without doing any of it.
 *
 * The Pull button asks for this first and then drives the steps itself, one
 * request each. That is what makes progress visible: the operator sees "HubSpot
 * deals — 1,200 rows" appear while contacts is still running, instead of a
 * spinner that either ends in a number or, as it did, in nothing.
 */
export async function syncPlan(sources?: SourceSystemCode[]): Promise<SyncStep[]> {
  const steps: SyncStep[] = [];

  for (const connector of CONNECTORS) {
    if (sources && !sources.includes(connector.sourceSystem)) continue;
    if (!(await connector.isConfigured())) continue;

    for (const entity of connector.entities()) {
      steps.push({
        source: connector.sourceSystem,
        sourceLabel: connector.label,
        entity: entity.entity,
        label: entity.label,
      });
    }
  }

  return steps;
}

/**
 * One slice of one entity: start it, or continue where the last slice stopped.
 *
 * Bounded by construction. Whatever the source holds, this returns inside the
 * fetch budget with everything it managed to read already landed, conformed and
 * committed — and says whether to come back for more.
 */
export async function runSlice(
  db: Database,
  user: SessionUser,
  input: {
    source: SourceSystemCode;
    entity: string;
    windowStart: string;
    windowEnd: string;
    loadRunId?: string | null;
  },
  options: SliceBudget = {},
): Promise<LoadOutcome> {
  if (!can(user, 'RUN_INGESTION')) {
    throw new Error('You are not permitted to run ingestion.');
  }

  if (input.loadRunId) return resumeLoadRun(db, user, input.loadRunId, options);

  return runLoad(
    db,
    user,
    {
      source: input.source,
      entity: input.entity,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    },
    options,
  );
}

/** The sources that could be synced right now, and why the others cannot. */
export async function syncableSources(): Promise<
  Array<{ source: SourceSystemCode; label: string; connected: boolean; entities: number }>
> {
  return Promise.all(
    CONNECTORS.map(async (connector) => ({
      source: connector.sourceSystem,
      label: connector.label,
      connected: await connector.isConfigured(),
      entities: connector.entities().length,
    })),
  );
}
