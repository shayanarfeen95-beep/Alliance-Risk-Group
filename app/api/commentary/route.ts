import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { openSemanticSession } from '@/lib/semantic/resolve';
import { evaluateGoalsForUser } from '@/lib/ai/goals';
import { generateCommentary } from '@/lib/ai/commentary';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Drafts the monthly close narrative.
 *
 * The draft is stored, never published — Westport edits and signs it, and until
 * they do the Executive dashboard shows it as an unsigned draft. Regenerating
 * replaces the draft and leaves any edit and signature alone, so a regeneration
 * cannot quietly unpick a narrative somebody already put their name to.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'SIGN_COMMENTARY')) {
    return NextResponse.json(
      { ok: false, error: 'Only Westport and administrators draft the close narrative.' },
      { status: 403 },
    );
  }

  let month: string;
  try {
    const body = (await request.json()) as { month?: string };
    month = /^\d{4}-\d{2}$/.test(body.month ?? '') ? `${body.month}-01` : String(body.month);
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new Error('bad month');
  } catch {
    return NextResponse.json({ ok: false, error: 'A reporting month is required.' }, { status: 400 });
  }

  const db = await getDb();
  const session = await openSemanticSession(db, user, month);
  const findings = await evaluateGoalsForUser(db, user, month, ['ON_REFRESH', 'ON_CLOSE', 'MONTHLY']);
  const commentary = await generateCommentary(session, findings);

  const [existing] = await db
    .select({ id: t.monthlyCommentary.id, signedAt: t.monthlyCommentary.signedAt })
    .from(t.monthlyCommentary)
    .where(and(eq(t.monthlyCommentary.periodMonth, month), isNull(t.monthlyCommentary.divisionCode)))
    .limit(1);

  if (existing?.signedAt) {
    return NextResponse.json({
      ok: false,
      error:
        'This month’s narrative is already signed. Regenerating would replace text somebody put their name to — unsign it first if that is what you want.',
    });
  }

  if (existing) {
    await db
      .update(t.monthlyCommentary)
      .set({ draft: commentary.body, citations: commentary.facts as unknown as object })
      .where(eq(t.monthlyCommentary.id, existing.id));
  } else {
    await db.insert(t.monthlyCommentary).values({
      periodMonth: month,
      draft: commentary.body,
      citations: commentary.facts as unknown as object,
    });
  }

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'COMMENTARY_DRAFTED',
    entity: 'monthly_commentary',
    entityId: month,
    detail: {
      modelWritten: commentary.modelWritten,
      rejectionReason: commentary.rejectionReason ?? null,
      factCount: commentary.facts.length,
    },
  });

  return NextResponse.json({
    ok: true,
    commentary: {
      body: commentary.body,
      modelWritten: commentary.modelWritten,
      rejectionReason: commentary.rejectionReason ?? null,
      factCount: commentary.facts.length,
      periodState: commentary.periodState,
    },
  });
}
