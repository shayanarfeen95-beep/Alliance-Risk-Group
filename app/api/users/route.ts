import { NextResponse } from 'next/server';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';

export const dynamic = 'force-dynamic';

type Role = 'ADMIN' | 'CFO' | 'EXECUTIVE' | 'DIVISION_MANAGER' | 'VIEWER';
const ROLES: Role[] = ['ADMIN', 'CFO', 'EXECUTIVE', 'DIVISION_MANAGER', 'VIEWER'];

/**
 * User administration — "super admin and delegation/access" from the notes.
 *
 * Two guards here are worth more than the rest of the file, because both
 * failures are unrecoverable from inside the app:
 *
 *   1. **You cannot remove your own administrator access.** An administrator
 *      who deactivates or demotes themselves has no way back in.
 *   2. **You cannot remove the last administrator.** Demoting or deactivating
 *      the only admin leaves a system nobody can administer, and the only fix
 *      is a database console.
 *
 * Both are checked against the database inside the same request that writes,
 * never against what the client sent.
 */

async function guard() {
  const user = await getSessionUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 }) };
  }
  if (!can(user, 'MANAGE_USERS')) {
    return {
      error: NextResponse.json(
        { ok: false, error: 'Only an administrator can manage people and access.' },
        { status: 403 },
      ),
    };
  }
  return { user };
}

/** Divisions a user may see. Empty means they can see everything. */
function normaliseDivisions(input: unknown, canViewConsolidated: boolean): string[] {
  if (canViewConsolidated) return [];
  return Array.isArray(input) ? input.map(String).filter(Boolean) : [];
}

export async function POST(request: Request) {
  const { user, error } = await guard();
  if (error) return error;

  let body: {
    email?: string; name?: string; role?: string; password?: string;
    canViewConsolidated?: boolean; divisions?: string[];
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim();
  const password = body.password ?? '';
  const role = (ROLES.includes(body.role as Role) ? body.role : 'VIEWER') as Role;
  const canViewConsolidated = Boolean(body.canViewConsolidated);
  const divisions = normaliseDivisions(body.divisions, canViewConsolidated);

  if (!email.includes('@')) return NextResponse.json({ ok: false, error: 'A valid email is required.' });
  if (name.length < 2) return NextResponse.json({ ok: false, error: 'A name is required.' });
  if (password.length < 12) {
    return NextResponse.json({ ok: false, error: 'Set a starting password of at least 12 characters.' });
  }
  // A user with neither consolidated access nor a division sees an empty app
  // and cannot tell whether that is a permission problem or a data problem.
  if (!canViewConsolidated && divisions.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'Give this person at least one division, or grant consolidated access — otherwise they see nothing.',
    });
  }

  const db = await getDb();

  let created;
  try {
    [created] = await db
      .insert(t.users)
      .values({ email, name, role, canViewConsolidated, passwordHash: await hashPassword(password) })
      .returning();
  } catch {
    return NextResponse.json({ ok: false, error: 'Someone already uses that email address.' });
  }

  if (divisions.length) {
    await db
      .insert(t.userDivisionAccess)
      .values(divisions.map((divisionCode) => ({ userId: created!.id, divisionCode })))
      .onConflictDoNothing();
  }

  await db.insert(t.auditEvent).values({
    userId: user!.id,
    action: 'USER_CREATED',
    entity: 'users',
    entityId: created!.id,
    detail: { email, role, canViewConsolidated, divisions },
  });

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const { user, error } = await guard();
  if (error) return error;

  let body: {
    userId?: string; role?: string; isActive?: boolean;
    canViewConsolidated?: boolean; divisions?: string[]; password?: string;
  };
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

  const nextRole = (ROLES.includes(body.role as Role) ? body.role : target.role) as Role;
  const nextActive = body.isActive ?? target.isActive;

  if (target.id === user!.id && (nextActive === false || nextRole !== 'ADMIN')) {
    return NextResponse.json({
      ok: false,
      error: 'You cannot remove your own administrator access — there would be no way back in. Ask another administrator.',
    });
  }

  // Backstop: never leave the system without an active administrator.
  //
  // Today this cannot fire — only an ADMIN holds MANAGE_USERS, the guard above
  // stops them acting on themselves, so an actor always counts as a remaining
  // admin. It is kept because that reasoning depends on the capability table:
  // the day MANAGE_USERS is granted to the CFO role, this becomes the only
  // thing standing between a routine demotion and a system nobody can
  // administer.
  if (target.role === 'ADMIN' && (nextRole !== 'ADMIN' || nextActive === false)) {
    const [row] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(t.users)
      .where(and(eq(t.users.role, 'ADMIN'), eq(t.users.isActive, true), ne(t.users.id, target.id)));

    if ((row?.remaining ?? 0) === 0) {
      return NextResponse.json({
        ok: false,
        error: 'This is the only active administrator. Promote someone else first, or nobody could administer the system.',
      });
    }
  }

  const canViewConsolidated = body.canViewConsolidated ?? target.canViewConsolidated;
  const divisions = normaliseDivisions(body.divisions, canViewConsolidated);

  if (!canViewConsolidated && divisions.length === 0 && body.divisions !== undefined) {
    return NextResponse.json({
      ok: false,
      error: 'Give this person at least one division, or grant consolidated access.',
    });
  }

  await db
    .update(t.users)
    .set({
      role: nextRole,
      isActive: nextActive,
      canViewConsolidated,
      ...(body.password && body.password.length >= 12
        ? { passwordHash: await hashPassword(body.password) }
        : {}),
    })
    .where(eq(t.users.id, userId));

  if (body.divisions !== undefined) {
    await db.delete(t.userDivisionAccess).where(eq(t.userDivisionAccess.userId, userId));
    if (divisions.length) {
      await db
        .insert(t.userDivisionAccess)
        .values(divisions.map((divisionCode) => ({ userId, divisionCode })))
        .onConflictDoNothing();
    }
  }

  await db.insert(t.auditEvent).values({
    userId: user!.id,
    action: 'USER_UPDATED',
    entity: 'users',
    entityId: userId,
    detail: {
      role: nextRole, isActive: nextActive, canViewConsolidated,
      divisions: body.divisions === undefined ? 'unchanged' : divisions,
      passwordReset: Boolean(body.password),
    },
  });

  return NextResponse.json({ ok: true });
}
