import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import { runSlice, syncPlan, SLICE_FETCH_BUDGET_MS, type SyncStep } from '@/lib/etl/ingest';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Keeping the warehouse current without anybody pressing a button.
 *
 * A dashboard is only worth opening if what it shows is what the source systems
 * say now. Leaving that to whoever remembers to press Pull means the figures are
 * as current as the last person who thought about it — which is how a board pack
 * comes to be built on a month-old pipeline.
 *
 * This cannot pull everything in one firing any more than the button could, and
 * it does not try. Each firing spends its budget on whatever is furthest behind:
 * an interrupted run resumes from its cursor first, then the entity that has
 * gone longest without a refresh. Successive firings converge on a fully current
 * warehouse and then keep it there, and no single firing can time out.
 *
 * How often it fires is a plan limit, not a design choice: Vercel's Hobby tier
 * allows one cron a day, so vercel.json asks for one, and a deployment carrying
 * anything more frequent is REJECTED outright rather than merely ignored. At one
 * firing a day this tops the stalest entities up rather than keeping everything
 * current — the Pull button in Admin is still how a full refresh happens. Raising
 * the schedule in vercel.json is the only change needed on a plan that allows it.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get('authorization');
    if (header !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Not authorised.' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Refusing is the safe failure. An unauthenticated endpoint that hammers
    // QuickBooks and HubSpot on demand is worse than one that does not run.
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET is not set, so the scheduled refresh will not run.' },
      { status: 503 },
    );
  }

  const db = await getDb();

  const operator = await ingestionIdentity(db);
  if (!operator) {
    return NextResponse.json({
      ok: false,
      error: 'No administrator or CFO account exists to attribute a scheduled load to.',
    });
  }

  // The whole firing has a budget, not just each fetch. Stopping with time to
  // spare is what keeps the response JSON rather than a gateway error.
  const deadline = Date.now() + 40_000;
  const done: Array<{ source: string; entity: string; rowsWritten: number; finished: boolean }> = [];

  try {
    const window = await reportingWindow(db);
    const steps = await syncPlan();

    if (steps.length === 0) {
      return NextResponse.json({ ok: true, ran: 0, note: 'No source is connected.' });
    }

    for (const step of await orderByStaleness(db, steps)) {
      if (Date.now() >= deadline) break;

      const outcome = await runSlice(
        db,
        operator,
        {
          source: step.source,
          entity: step.entity,
          windowStart: window.start,
          windowEnd: window.end,
          loadRunId: step.resumeRunId,
        },
        { deadline: Math.min(deadline, Date.now() + SLICE_FETCH_BUDGET_MS) },
      );

      done.push({
        source: outcome.source,
        entity: outcome.entity,
        rowsWritten: outcome.rowsWritten,
        finished: outcome.done,
      });
    }

    if (done.length > 0) {
      const recon = await runAllChecks(db);
      await persistFindings(db, recon.findings);
    }

    return NextResponse.json({ ok: true, ran: done.length, slices: done });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      ran: done.length,
      slices: done,
      error: error instanceof Error ? error.message : 'The scheduled refresh failed.',
    });
  }
}

/**
 * Whose name a scheduled load is recorded under.
 *
 * Every load_run and audit row names a person, because a warehouse whose
 * provenance says "system" cannot answer "who pulled this". The refresh runs as
 * the administrator who owns ingestion.
 */
async function ingestionIdentity(db: Database): Promise<SessionUser | null> {
  const [row] = await db
    .select()
    .from(t.users)
    .where(and(eq(t.users.isActive, true), inArray(t.users.role, ['ADMIN', 'CFO'])))
    .orderBy(t.users.role)
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    canViewConsolidated: row.canViewConsolidated,
    divisionCodes: [],
  };
}

/** The same anchored window the Pull button uses — never reaching past it. */
async function reportingWindow(db: Database): Promise<{ start: string; end: string }> {
  const [configured] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const end = configured?.value ?? new Date().toISOString().slice(0, 8) + '01';
  const [year, month] = end.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 3, 1));
  const start = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;

  return { start, end };
}

interface RefreshStep extends SyncStep {
  /** Set when a previous firing left this entity mid-pull. */
  resumeRunId: string | null;
}

/**
 * Unfinished pulls first, then whatever was refreshed longest ago.
 *
 * Without this every firing would restart at QuickBooks and the last entities in
 * the list would never be reached — the warehouse would be permanently current
 * at one end and permanently stale at the other, with nothing on screen saying
 * which end you were looking at.
 */
async function orderByStaleness(db: Database, steps: SyncStep[]): Promise<RefreshStep[]> {
  const runs = await db
    .select({
      id: t.loadRun.id,
      sourceSystem: t.loadRun.sourceSystem,
      entity: t.loadRun.entity,
      status: t.loadRun.status,
      startedAt: t.loadRun.startedAt,
    })
    .from(t.loadRun)
    .where(inArray(t.loadRun.status, ['RUNNING', 'SUCCEEDED']))
    .orderBy(desc(t.loadRun.startedAt))
    .limit(500);

  const latest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    const key = `${run.sourceSystem}:${run.entity}`;
    if (!latest.has(key)) latest.set(key, run);
  }

  // The sort below is stable, so entities that have never loaded keep the plan's
  // own order — which is what makes reference data land before the facts that
  // read it on a first refresh, HubSpot owners before HubSpot deals above all.
  return steps
    .map((step) => {
      const run = latest.get(`${step.source}:${step.entity}`);
      const resuming = run?.status === 'RUNNING';
      return {
        ...step,
        resumeRunId: resuming ? run!.id : null,
        // An entity never loaded is the stalest thing there is.
        rank: resuming ? -1 : (run?.startedAt?.getTime() ?? 0),
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...step }) => step);
}
