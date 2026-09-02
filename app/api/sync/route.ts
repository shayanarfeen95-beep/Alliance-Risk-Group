import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { syncAll } from '@/lib/etl/ingest';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Pull everything, now.
 *
 * Ingestion used to be reachable only by asking the assistant to propose a pull
 * and then confirming it. That is the right shape for "pull March because the
 * numbers look wrong", and the wrong shape for "I have just connected
 * QuickBooks and want my data" — which is the first thing anybody does.
 *
 * The click is the confirmation, so there is no preview step; everything else is
 * identical, because both paths run the same code in lib/etl/ingest.ts. The
 * reconciliation controls run straight afterwards, so a load that breaks a
 * tie-out says so in the same response rather than at the next refresh.
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

  let body: { sources?: SourceSystemCode[]; months?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means "everything connected", which is the common case.
  }

  const db = await getDb();

  // Anchored on the configured reporting month rather than today, so a sync does
  // not silently reach into a month the business has not started reporting on.
  const [configured] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const anchor = configured?.value ?? new Date().toISOString().slice(0, 8) + '01';
  const months = Math.min(Math.max(body.months ?? 3, 1), 36);
  const windowEnd = anchor;
  const windowStart = shiftMonths(anchor, -(months - 1));

  let outcomes;
  try {
    outcomes = await syncAll(db, user, {
      windowStart,
      windowEnd,
      sources: body.sources,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'The sync could not start.',
    });
  }

  if (outcomes.length === 0) {
    return NextResponse.json({
      ok: false,
      error:
        'No source is connected yet, so there was nothing to pull. Sign in to QuickBooks, HubSpot ' +
        'or Google Sheets above first.',
    });
  }

  // A load that breaks a standing control must say so now, not overnight.
  const recon = await runAllChecks(db);
  await persistFindings(db, recon.findings, outcomes[0]?.loadRunId || undefined);

  const rowsWritten = outcomes.reduce((sum, outcome) => sum + outcome.rowsWritten, 0);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  return NextResponse.json({
    ok: true,
    window: `${windowStart.slice(0, 7)} → ${windowEnd.slice(0, 7)}`,
    rowsWritten,
    outcomes: outcomes.map((outcome) => ({
      source: outcome.source,
      entity: outcome.entity,
      ok: outcome.ok,
      rowsWritten: outcome.rowsWritten,
      notes: outcome.notes,
      error: outcome.error,
    })),
    failedCount: failed.length,
    reconciliation: recon.allPass
      ? `All ${recon.passed} reconciliation controls pass.`
      : `${recon.failed} reconciliation control${recon.failed === 1 ? '' : 's'} now fail — check below before relying on affected figures.`,
  });
}

function shiftMonths(month: string, delta: number): string {
  const [year, monthOfYear] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthOfYear - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
