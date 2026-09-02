import 'server-only';
import { and, eq } from 'drizzle-orm';
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
}

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
  run: { id: string; sourceSystem: string; entity: string; windowStart: string | null; windowEnd: string | null },
  auditAction: string,
): Promise<LoadOutcome> {
  const connector = getConnector(run.sourceSystem as SourceSystemCode);
  const base = {
    source: run.sourceSystem as SourceSystemCode,
    entity: run.entity,
    loadRunId: run.id,
    recordsRead: 0,
    rowsWritten: 0,
    notes: [] as string[],
  };

  try {
    const batch = await connector.fetch(run.entity, {
      start: run.windowStart!,
      end: run.windowEnd!,
    });

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

    await db
      .update(t.loadRun)
      .set({
        status: 'SUCCEEDED',
        rowsRead: batch.records.length,
        rowsWritten: conformed.rowsWritten,
        finishedAt: new Date(),
      })
      .where(eq(t.loadRun.id, run.id));

    await db.insert(t.auditEvent).values({
      userId: user.id,
      action: auditAction,
      entity: 'load_run',
      entityId: run.id,
      detail: {
        source: run.sourceSystem,
        entity: run.entity,
        records: batch.records.length,
        rowsWritten: conformed.rowsWritten,
        notes: conformed.notes,
      },
    });

    return {
      ...base,
      ok: true,
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

    return { ...base, ok: false, error: message };
  }
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

  return executeLoadRun(db, user, run!, 'SOURCE_SYNCED');
}

/**
 * Every entity of every connected source, in one pass.
 *
 * Entities are pulled in sequence rather than in parallel. QuickBooks and
 * HubSpot both rate limit aggressively, and a refresh that trips a 429 halfway
 * through leaves the warehouse holding half a month — which looks like a real
 * decline in revenue rather than a failed load.
 */
export async function syncAll(
  db: Database,
  user: SessionUser,
  input: { windowStart: string; windowEnd: string; sources?: SourceSystemCode[] },
): Promise<LoadOutcome[]> {
  if (!can(user, 'RUN_INGESTION')) {
    throw new Error('You are not permitted to run ingestion.');
  }

  const wanted = input.sources;
  const outcomes: LoadOutcome[] = [];

  for (const connector of CONNECTORS) {
    if (wanted && !wanted.includes(connector.sourceSystem)) continue;
    if (!(await connector.isConfigured())) continue;

    for (const entity of connector.entities()) {
      outcomes.push(
        await runLoad(db, user, {
          source: connector.sourceSystem,
          entity: entity.entity,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        }),
      );
    }
  }

  return outcomes;
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
