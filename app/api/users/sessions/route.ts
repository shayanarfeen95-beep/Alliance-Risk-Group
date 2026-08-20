import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/**
 * Ends every session a person holds.
 *
 * Deactivating an account already stops the next request — `getSessionUser`
 * checks `isActive` on every call — so this is not the only way to shut
 * somebody out. It is the way to shut them out *without* deactivating them:
 * after a role change, after a laptop goes missing, after a contractor's
 * engagement ends but their account is being kept for the audit trail.
 *
 * A role change is the common one and the least obvious. Entitlements are read
 * fresh on every request, so a demotion takes effect immediately — but the
 * person is still holding a session that was minted under the old role, and an
 * administrator who has just narrowed someone's access should be able to end it
 * outright rather than reason about which parts refresh when.
 */
export async function POST(request: Request) {
  const actor = await getSessionUser();
  if (!actor) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(actor, 'MANAGE_USERS')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator can end another person’s sessions.' },
      { status: 403 },
    );
  }

  let body: { userId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const userId = body.userId ?? '';
  if (!userId) return NextResponse.json({ ok: false, error: 'No user specified.' }, { status: 400 });

  const db = await getDb();
  const [target] = await db.select().from(t.users).where(eq(t.users.id, userId)).limit(1);
  if (!target) return NextResponse.json({ ok: false, error: 'That user no longer exists.' });

  // Signing yourself out from the people screen is almost always a misclick,
  // and the cost is losing the session you are administering from.
  if (target.id === actor.id) {
    return NextResponse.json({
      ok: false,
      error: 'That would end your own session. Use Sign out if you meant to.',
    });
  }

  const removed = await db.delete(t.sessions).where(eq(t.sessions.userId, userId)).returning();

  await db.insert(t.auditEvent).values({
    userId: actor.id,
    action: 'USER_SESSIONS_REVOKED',
    entity: 'sessions',
    entityId: userId,
    detail: { email: target.email, sessionsEnded: removed.length },
  });

  return NextResponse.json({
    ok: true,
    sessionsEnded: removed.length,
    // Said plainly, because "0 sessions ended" reads like a failure and is
    // usually just somebody who was already signed out.
    message:
      removed.length === 0
        ? `${target.name} had no active sessions.`
        : `Ended ${removed.length} session${removed.length === 1 ? '' : 's'} for ${target.name}.`,
  });
}
