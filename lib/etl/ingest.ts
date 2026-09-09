import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
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
}

/** Where a run is resuming from, kept on `load_run.plan`. */
interface RunPlan {
  startedFrom?: string;
  cursor?: string | null;
  slices?: number;
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
  options: SliceBudget = {},
): Promise<LoadOutcome> {
  const connector = getConnector(run.sourceSystem as SourceSystemCode);
  const priorPlan = (run.plan ?? {}) as RunPlan;
  const slices = (priorPlan.slices ?? 0) + 1;

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
      },
    );

    // Raw landing first, so conform can be re-run without re-hitting the API.
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

    // Then conform, in the same run. Landing raw data and stopping was the gap
    // that let a connected source and a seeded dashboard coexist with nothing
    // anywhere saying the two were unrelated.
    const conformed = await conformBatch(db, run.id, batch);

    const done = !batch.nextCursor;

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
        plan: { ...priorPlan, cursor: batch.nextCursor ?? null, slices },
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
          notes: conformed.notes,
        },
      });
    }

    return {
      ...base,
      ok: true,
      done,
      recordsRead: batch.records.length,
      rowsWritten: conformed.rowsWritten,
      notes: conformed.notes,
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

  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem: input.source,
      entity: input.entity,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: 'RUNNING',
      requestedByUserId: user.id,
      confirmedAt: new Date(),
      plan: { startedFrom: 'admin_sync' },
    })
    .returning();

  return executeLoadRun(db, user, run!, 'SOURCE_SYNCED', options);
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
