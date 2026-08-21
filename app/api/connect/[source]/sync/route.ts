import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getConnector, type SourceSystemCode } from '@/lib/connectors';
import { confirmExtraction } from '@/lib/ai/tools';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';
import { addMonths, monthRange } from '@/lib/semantic/periods';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Pull now.
 *
 * Ingestion previously ran only through the assistant, which meant a deployment
 * without an ANTHROPIC_API_KEY could connect a source and never read from it —
 * the conversational layer is optional, and importing data is not.
 *
 * Clicking the button *is* the confirmation, so this creates the run and
 * confirms it in one request. It goes through exactly the same
 * `confirmExtraction` path the assistant uses: same landing, same conform, same
 * provenance, same reconciliation afterwards. Two ways to start a load, one way
 * for a load to happen.
 */
export async function POST(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'RUN_INGESTION')) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'You are not permitted to pull data. An administrator or the CFO is — or can lend you the capability from Admin → Delegated access.',
      },
      { status: 403 },
    );
  }

  let body: { entity?: string; fromMonth?: string; toMonth?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  let connector;
  try {
    connector = getConnector(sourceSystem);
  } catch {
    return NextResponse.json({ ok: false, error: `No connector for ${source}.` }, { status: 404 });
  }

  const entity = (body.entity ?? '').trim();
  if (!connector.entities().some((candidate) => candidate.entity === entity)) {
    return NextResponse.json({
      ok: false,
      error: `"${entity}" is not something ${connector.label} exposes.`,
    });
  }

  if (!(await connector.isConfigured())) {
    return NextResponse.json({
      ok: false,
      error: `${connector.label} is not connected yet, so there is nothing to pull from. Connect it above first — nothing was written.`,
    });
  }

  const db = await getDb();

  // Default window: the last three months, which is what somebody clicking a
  // button on a connector card almost always means. A wider backfill is a
  // deliberate choice made with the date fields.
  const [defaultMonthRow] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const anchor = normaliseMonth(defaultMonthRow?.value) ?? currentMonth();
  const windowEnd = normaliseMonth(body.toMonth) ?? anchor;
  const windowStart = normaliseMonth(body.fromMonth) ?? addMonths(windowEnd, -2);

  if (windowStart > windowEnd) {
    return NextResponse.json({ ok: false, error: 'The start month is after the end month.' });
  }
  if (monthRange(windowStart, windowEnd).length > 36) {
    return NextResponse.json({
      ok: false,
      error:
        'That window is longer than three years. Pull it in smaller pieces — a single request that long will time out before it finishes, and a half-finished load is worse than none.',
    });
  }

  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem,
      entity,
      windowStart,
      windowEnd,
      status: 'PREVIEW',
      requestedByUserId: user.id,
      plan: { reason: 'Requested from Admin → Source connections', months: monthRange(windowStart, windowEnd).length },
    })
    .returning();

  const outcome = await confirmExtraction(db, user, run!.id);

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.message });
  }

  // The standing controls run immediately, so a load that breaks a tie-out says
  // so now rather than at the next refresh.
  const recon = await runAllChecks(db);
  await persistFindings(db, recon.findings, run!.id);

  return NextResponse.json({
    ok: true,
    message: `${outcome.message} ${
      recon.allPass
        ? `All ${recon.passed} reconciliation controls still pass.`
        : `${recon.failed} reconciliation control${recon.failed === 1 ? '' : 's'} now fail — check Admin before relying on affected figures.`
    }`,
  });
}

function normaliseMonth(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
