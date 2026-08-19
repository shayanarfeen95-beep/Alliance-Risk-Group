import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { confirmExtraction, confirmPendingAction } from '@/lib/ai/tools';
import { getDb } from '@/lib/db/client';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The confirm step.
 *
 * Nothing an agent proposes reaches the warehouse without passing through here,
 * and getting here requires a human to have clicked the control. The run is then
 * followed immediately by the standing reconciliation checks, so a load that
 * breaks a tie-out says so in the same breath rather than at the next refresh.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }

  let actionId: string;
  try {
    const body = (await request.json()) as { actionId?: string };
    if (!body.actionId) throw new Error('missing');
    actionId = body.actionId;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const db = await getDb();

  // Two kinds of proposal reach this control: an extraction awaiting its pull,
  // and a mapping change awaiting its apply. Both are stored server-side and
  // both require this click; the id says which.
  const pending = await confirmPendingAction(db, user, actionId);
  if (pending.handled) {
    return NextResponse.json({
      ok: true,
      message: {
        role: 'assistant',
        content: pending.message,
        isRefusal: !pending.ok,
      },
    });
  }

  const outcome = await confirmExtraction(db, user, actionId);

  if (!outcome.ok) {
    return NextResponse.json({
      ok: true,
      message: { role: 'assistant', content: outcome.message, isRefusal: true },
    });
  }

  const recon = await runAllChecks(db);
  await persistFindings(db, recon.findings, actionId);

  const reconLine = recon.allPass
    ? `All ${recon.passed} reconciliation controls still pass.`
    : `${recon.failed} reconciliation control${recon.failed === 1 ? '' : 's'} now fail — check the Admin view before relying on affected figures.`;

  return NextResponse.json({
    ok: true,
    message: {
      role: 'assistant',
      content: `${outcome.message}\n\n${reconLine}`,
      activity: [{ tool: 'run_recon', summary: `Ran ${recon.findings.length} reconciliation controls` }],
    },
  });
}
