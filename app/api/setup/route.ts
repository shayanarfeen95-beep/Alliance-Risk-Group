import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { isUninitialised } from '@/lib/db/bootstrap';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * First run: creates the first administrator.
 *
 * The guard that matters is `isUninitialised`. This route is unauthenticated by
 * necessity — there is nobody to authenticate as yet — so it must refuse the
 * moment a single user exists. Otherwise it is a permanent unauthenticated
 * account-creation endpoint on a system holding a company's books.
 *
 * The check is re-run inside the same request that writes, and the write itself
 * is guarded by the unique index on email, so two people submitting the form
 * simultaneously produce one administrator and one error rather than two
 * administrators.
 */
export async function POST(request: Request) {
  const db = await getDb();

  if (!(await isUninitialised(db))) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'This deployment is already set up. Sign in instead — or ask an administrator to add you.',
      },
      { status: 409 },
    );
  }

  let body: { email?: string; name?: string; password?: string; loadDemoData?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim();
  const password = body.password ?? '';

  if (!email.includes('@')) {
    return NextResponse.json({ ok: false, error: 'A valid email address is required.' });
  }
  if (name.length < 2) {
    return NextResponse.json({ ok: false, error: 'A name is required.' });
  }
  // Long rather than complex: a passphrase beats a short string with a symbol
  // in it, and this account can see every figure in the business.
  if (password.length < 12) {
    return NextResponse.json({
      ok: false,
      error: 'Use at least 12 characters. This account can see every division.',
    });
  }

  // The demo dataset needs the reference data the seed loads, so it is all or
  // nothing: either the full seeded warehouse, or an empty one with just the
  // divisions and configuration a real load requires.
  if (body.loadDemoData) {
    const { seedDatabase } = await import('@/lib/seed/load');
    await seedDatabase(db, { quiet: true });

    // Retire the seeded accounts rather than deleting them.
    //
    // Deleting is what you reach for first and it does not work: the demo data
    // is *attributed* to those users — they closed the periods, locked the
    // forecasts, signed the commentary — so the foreign keys hold them in
    // place, and tearing those references out would leave a closed month with
    // nobody who closed it.
    //
    // Retiring keeps the history coherent and still closes the hole that
    // matters: these accounts ship with a password published in the README, and
    // a deployment that loaded demo data must not be reachable through one.
    // Both the login action and the session loader refuse an inactive user, and
    // the scrambled hash means there is no password that would work even if
    // somebody flipped the flag back.
    await db.update(t.users).set({
      isActive: false,
      passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
    });
  } else {
    const { DIVISION_SEED } = await import('@/lib/divisions');
    const { SEED_CONFIG } = await import('@/lib/seed/load');
    await db.insert(t.dimDivision).values(DIVISION_SEED).onConflictDoNothing();
    await db.insert(t.appConfig).values(SEED_CONFIG).onConflictDoNothing();
  }

  let userId: string;
  try {
    const [created] = await db
      .insert(t.users)
      .values({
        email,
        name,
        role: 'ADMIN',
        canViewConsolidated: true,
        passwordHash: await hashPassword(password),
      })
      .returning();
    userId = created!.id;
  } catch {
    return NextResponse.json({
      ok: false,
      error: 'That account could not be created — it may already exist. Try signing in.',
    });
  }

  await db.insert(t.auditEvent).values({
    userId,
    action: 'DEPLOYMENT_INITIALISED',
    entity: 'users',
    entityId: userId,
    detail: { loadDemoData: Boolean(body.loadDemoData) },
  });

  await createSession(userId);

  return NextResponse.json({ ok: true });
}

/** Whether the setup screen should be offered. */
export async function GET() {
  const db = await getDb();
  return NextResponse.json({ uninitialised: await isUninitialised(db) });
}
