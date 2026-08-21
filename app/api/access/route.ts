import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can, DELEGABLE_CAPABILITIES, type Capability } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/**
 * Lending a capability, and taking it back.
 *
 * Three rules, each of which exists because of a way this goes wrong:
 *
 *   1. **Only a super admin may lend.** Otherwise a lent permission can be used
 *      to lend more, and one grant becomes an org chart nobody wrote.
 *   2. **A reason is required.** A grant with no stated reason cannot be
 *      reviewed six weeks later, which is exactly when somebody asks.
 *   3. **Revoking is a timestamp, not a delete.** The record of who could do
 *      what, and when, survives the grant ending — that is the whole point of
 *      having it.
 */

async function guard() {
  const user = await getSessionUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 }),
    };
  }
  if (!can(user, 'DELEGATE_ACCESS')) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error:
            'Only a super administrator can lend access. Delegating is deliberately not itself delegable — a lent permission cannot be used to lend more.',
        },
        { status: 403 },
      ),
    };
  }
  return { user };
}

export async function POST(request: Request) {
  const { user, error } = await guard();
  if (error) return error;

  let body: {
    userId?: string;
    capability?: string;
    divisionCode?: string | null;
    reason?: string;
    expiresAt?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const capability = body.capability as Capability;
  if (!DELEGABLE_CAPABILITIES.includes(capability)) {
    return NextResponse.json({
      ok: false,
      error: `"${body.capability}" cannot be lent. Delegable capabilities are: ${DELEGABLE_CAPABILITIES.join(', ')}.`,
    });
  }

  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return NextResponse.json({
      ok: false,
      error:
        'A reason is required. A grant nobody can explain six weeks later is one nobody will revoke.',
    });
  }

  if (!body.userId) {
    return NextResponse.json({ ok: false, error: 'Name the person to grant it to.' });
  }

  const db = await getDb();

  const [recipient] = await db
    .select({ id: t.users.id, name: t.users.name, isActive: t.users.isActive })
    .from(t.users)
    .where(eq(t.users.id, body.userId))
    .limit(1);

  if (!recipient) {
    return NextResponse.json({ ok: false, error: 'No such person.' }, { status: 404 });
  }
  if (!recipient.isActive) {
    return NextResponse.json({
      ok: false,
      error: `${recipient.name} is deactivated. Reactivate them first — a grant to somebody who cannot sign in is a grant nobody will notice later.`,
    });
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ ok: false, error: 'That end date could not be read.' });
    }
    if (parsed.getTime() <= Date.now()) {
      return NextResponse.json({
        ok: false,
        error: 'That end date is in the past, so the grant would never be live.',
      });
    }
    expiresAt = parsed;
  }

  const [grant] = await db
    .insert(t.accessGrant)
    .values({
      userId: recipient.id,
      capability,
      divisionCode: body.divisionCode ?? null,
      grantedBy: user!.id,
      reason,
      expiresAt,
    })
    .returning();

  await db.insert(t.auditEvent).values({
    userId: user!.id,
    action: 'ACCESS_GRANTED',
    entity: 'access_grant',
    entityId: grant!.id,
    detail: {
      to: recipient.name,
      capability,
      divisionCode: body.divisionCode ?? null,
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    message: expiresAt
      ? `${recipient.name} can ${capability.toLowerCase().replace(/_/g, ' ')} until ${expiresAt.toLocaleDateString('en-US')}.`
      : `${recipient.name} can ${capability.toLowerCase().replace(/_/g, ' ')} until this is revoked.`,
  });
}

export async function PATCH(request: Request) {
  const { user, error } = await guard();
  if (error) return error;

  let body: { grantId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }
  if (!body.grantId) {
    return NextResponse.json({ ok: false, error: 'Which grant?' }, { status: 400 });
  }

  const db = await getDb();

  // Revoking is a timestamp, not a delete: the record of who could do what, and
  // when, is the reason the table exists.
  const revoked = await db
    .update(t.accessGrant)
    .set({ revokedAt: new Date(), revokedBy: user!.id })
    .where(and(eq(t.accessGrant.id, body.grantId), isNull(t.accessGrant.revokedAt)))
    .returning();

  if (revoked.length === 0) {
    return NextResponse.json({ ok: false, error: 'That grant is already revoked, or gone.' });
  }

  await db.insert(t.auditEvent).values({
    userId: user!.id,
    action: 'ACCESS_REVOKED',
    entity: 'access_grant',
    entityId: body.grantId,
    detail: { capability: revoked[0]!.capability },
  });

  return NextResponse.json({ ok: true, message: 'Revoked. It takes effect on their next request.' });
}
