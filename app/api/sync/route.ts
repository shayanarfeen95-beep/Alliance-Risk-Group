import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { runSlice, syncPlan, resetWatermarks, SLICE_FETCH_BUDGET_MS } from '@/lib/etl/ingest';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Pulling data, a slice at a time.
 *
 * The click is the confirmation, so there is no preview step; everything else is
 * identical to an agent-initiated pull, because both run the same code in
 * lib/etl/ingest.ts. There is still no second, weaker ingestion path.
 *
 * What changed is the shape of the request. Pulling every entity of every
 * connected source inside one HTTP call is not something a serverless function
 * can do — a real HubSpot portal alone is hundreds of paginated round trips —
 * and the attempt died at the platform timeout, which reaches the browser as a
 * gateway error rather than as JSON. The operator saw "The request did not
 * complete" and had no way to tell an expired budget from a broken connection.
 *
 * So the work is split into requests that are each comfortably short, and the
 * browser drives them:
 *
 *   plan     — what would be pulled, given what is connected
 *   slice    — fetch, land and conform as much of one entity as fits, then say
 *              whether to come back for the rest
 *   finalize — run the reconciliation controls once, at the end
 *
 * Each slice commits what it read, so an interrupted pull leaves real data
 * behind and resumes from its cursor rather than starting again.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'RUN_INGESTION')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can pull data from a source.' },
      { status: 403 },
    );
  }

  let body: {
    mode?: 'plan' | 'slice' | 'finalize';
    sources?: SourceSystemCode[];
    months?: number;
    source?: SourceSystemCode;
    entity?: string;
    windowStart?: string;
    windowEnd?: string;
    loadRunId?: string | null;
    fullRefresh?: boolean;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means "plan everything connected", which is the common case.
  }

  const db = await getDb();

  try {
    switch (body.mode ?? 'plan') {
      case 'plan':
        return NextResponse.json(await plan(db, body));
      case 'slice':
        return NextResponse.json(await slice(db, user, body));
      case 'finalize':
        return NextResponse.json(await finalize(db));
      default:
        return NextResponse.json({ ok: false, error: 'Unknown sync mode.' }, { status: 400 });
    }
  } catch (error) {
    // Anything that escapes still leaves the browser holding JSON. A pull that
    // fails must say what failed; "the request did not complete" is what a
    // gateway says when this route says nothing at all.
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'The sync could not run.',
    });
  }
}

type Db = Awaited<ReturnType<typeof getDb>>;

async function plan(
  db: Db,
  body: { sources?: SourceSystemCode[]; months?: number; fullRefresh?: boolean },
) {
  /**
   * How far back to fetch, ending at the month we are actually in.
   *
   * This used to end at DEFAULT_REPORTING_MONTH, on the reasoning that a sync
   * should not reach into a month the business has not started reporting on.
   * That confused two different things. The reporting month is a DISPLAY
   * choice — which month the dashboards open on — and it is set once and rarely
   * moved. How far the books have been kept is a fact about the source.
   *
   * Using the first for the second meant that with the reporting month sitting
   * at its seeded 2026-03, a pull run in September fetched January, February and
   * March and stopped. Six months of QuickBooks had never been fetched and never
   * would be, however many times anybody pressed Pull. Nothing said so: the
   * window was printed on the screen and read as a description of the data
   * rather than as a limit on it.
   *
   * The window now ends at the current month. Fetching an open month is
   * harmless — conform refuses to write a closed one anyway — and the reporting
   * month goes back to meaning only what it says.
   */
  const [configured] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const thisMonth = new Date().toISOString().slice(0, 8) + '01';
  // Never earlier than the reporting month: a deployment configured to report on
  // a month ahead of the calendar still gets that month fetched.
  const windowEnd =
    configured?.value && configured.value > thisMonth ? configured.value : thisMonth;

  // Twelve, not three. A first load of a year of books is the common case, and
  // three months was not enough to fill a single trailing-twelve chart.
  const months = Math.min(Math.max(body.months ?? 12, 1), 36);
  const windowStart = shiftMonths(windowEnd, -(months - 1));

  // A full re-import is the watermarks being cleared, once, before the first
  // slice — not a flag every slice has to carry and could disagree about.
  if (body.fullRefresh) await resetWatermarks(db, body.sources);

  const steps = await syncPlan(body.sources);

  if (steps.length === 0) {
    return {
      ok: false,
      error:
        'No source is connected yet, so there is nothing to pull. Sign in to QuickBooks, HubSpot ' +
        'or Google Sheets above first.',
    };
  }

  return {
    ok: true,
    mode: 'plan' as const,
    windowStart,
    windowEnd,
    window: `${windowStart.slice(0, 7)} → ${windowEnd.slice(0, 7)}`,
    /**
     * What the window actually constrains, which is not the same for every
     * source. QuickBooks is fetched one report per month, so the window is a
     * real limit. HubSpot is fetched by object and filtered on modification
     * time, so the window constrains nothing at all — printing a month range
     * over a HubSpot pull describes a filter that does not exist, and invites
     * exactly the question "why only three months?" about an import that was
     * never limited to three months.
     */
    windowApplies: steps.some((step) => step.source === 'QBO'),
    steps,
    fullRefresh: Boolean(body.fullRefresh),
  };
}

async function slice(
  db: Db,
  user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  body: {
    source?: SourceSystemCode;
    entity?: string;
    windowStart?: string;
    windowEnd?: string;
    loadRunId?: string | null;
    fullRefresh?: boolean;
  },
) {
  if (!body.source || !body.entity || !body.windowStart || !body.windowEnd) {
    return { ok: false, error: 'A slice needs a source, an entity and a window.' };
  }

  const outcome = await runSlice(
    db,
    user,
    {
      source: body.source,
      entity: body.entity,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
      loadRunId: body.loadRunId ?? null,
    },
    { deadline: Date.now() + SLICE_FETCH_BUDGET_MS, fullRefresh: body.fullRefresh },
  );

  return {
    ok: true,
    mode: 'slice' as const,
    outcome: {
      source: outcome.source,
      entity: outcome.entity,
      ok: outcome.ok,
      done: outcome.done,
      loadRunId: outcome.loadRunId,
      recordsRead: outcome.recordsRead,
      rowsWritten: outcome.rowsWritten,
      slices: outcome.slices,
      notes: outcome.notes,
      error: outcome.error,
    },
  };
}

/** A load that breaks a standing control must say so now, not overnight. */
async function finalize(db: Db) {
  const recon = await runAllChecks(db);
  await persistFindings(db, recon.findings);

  return {
    ok: true,
    mode: 'finalize' as const,
    reconciliation: recon.allPass
      ? `All ${recon.passed} reconciliation controls pass.`
      : `${recon.failed} reconciliation control${recon.failed === 1 ? '' : 's'} now fail — check below before relying on affected figures.`,
    allPass: recon.allPass,
  };
}

function shiftMonths(month: string, delta: number): string {
  const [year, monthOfYear] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthOfYear - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
