/**
 * Session handling.
 *
 * A signed JWT in an httpOnly cookie, backed by a `sessions` row so a session
 * can be revoked server-side. Deliberately small and dependency-light: the
 * identity provider is pluggable (§14.3 open item 5 leaves the access model to
 * Westport), and adding Google Workspace SSO later means adding a second way to
 * mint the same session, not replacing this.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { getDb } from '@/lib/db/client';
import { sessions, users, userDivisionAccess } from '@/lib/db/schema';

const COOKIE_NAME = 'arg_session';
const SESSION_DAYS = 7;

export type Role = 'ADMIN' | 'CFO' | 'EXECUTIVE' | 'DIVISION_MANAGER' | 'VIEWER';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** true = may see ARG Total and every division. */
  canViewConsolidated: boolean;
  /** Division codes this user is entitled to. Empty when consolidated. */
  divisionCodes: string[];
}

/**
 * Signing key for the session token.
 *
 * A fresh clone runs with `pnpm db:migrate && pnpm db:seed && pnpm dev` and no
 * configuration at all — the same reason the database defaults to embedded
 * PGlite. Outside development the absence of a real secret is fatal: a
 * predictable signing key would let anyone mint a session.
 */
const DEV_FALLBACK_SECRET = 'arg-development-only-secret-do-not-use-in-production';

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_SECRET is not set. Generate one with `openssl rand -base64 48` and set it in the environment before deploying.',
      );
    }
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(value);
}

export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db.insert(sessions).values({ userId, expiresAt }).returning();
  if (!row) throw new Error('failed to create session');

  const token = await new SignJWT({ sid: row.id, uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      const db = await getDb();
      await db.delete(sessions).where(eq(sessions.id, payload.sid as string));
    } catch {
      // An unverifiable cookie is already useless; just clear it.
    }
  }
  store.delete(COOKIE_NAME);
}

/** Returns the signed-in user, or null. Never throws on a bad cookie. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let sid: string;
  try {
    const { payload } = await jwtVerify(token, secret());
    sid = payload.sid as string;
  } catch {
    return null;
  }

  const db = await getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1);
  if (!session || session.expiresAt.getTime() < Date.now()) return null;

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || !user.isActive) return null;

  const access = await db
    .select({ divisionCode: userDivisionAccess.divisionCode })
    .from(userDivisionAccess)
    .where(eq(userDivisionAccess.userId, user.id));

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    canViewConsolidated: user.canViewConsolidated,
    divisionCodes: access.map((a) => a.divisionCode),
  };
}

/** For routes that must have a user. Throws rather than rendering an empty page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  return user;
}
