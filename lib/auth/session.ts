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
import { createHash, randomBytes } from 'node:crypto';
import { getDb, isDemoMode } from '@/lib/db/client';
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

/**
 * The signing key a demo instance uses when no secret is configured.
 *
 * This was a per-process random value, and on a serverless host that is a
 * logout on almost every click. Vercel runs many instances of one deployment;
 * a user signs in on instance A, clicks a tab, is served by instance B, and B
 * cannot verify a token signed with A's random key. The session looks expired
 * one second after logging in, which reads as a broken application rather than
 * as a missing environment variable.
 *
 * So the key is derived from something every instance of one deployment agrees
 * on and nobody outside it can read back: the deployment id, the commit, or the
 * project id. It is still not a configured secret — it rotates on every deploy,
 * which signs everyone out on release, and that is the correct trade for a demo
 * instance holding seeded figures. A real deployment sets AUTH_SECRET and none
 * of this applies.
 */
let demoSecret: Uint8Array | null = null;

function deriveDemoSecret(): Uint8Array {
  if (demoSecret) return demoSecret;

  const stable =
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_PROJECT_ID ??
    process.env.VERCEL_URL;

  demoSecret = stable
    ? new Uint8Array(createHash('sha256').update(`arg-demo-session:${stable}`).digest())
    : // Nothing stable to derive from — a single-process demo, where a random
      // key costs nothing because there is no second instance to disagree.
      new Uint8Array(randomBytes(48));

  return demoSecret;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    if (isDemoMode()) return deriveDemoSecret();
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_SECRET is not set. Generate one with `openssl rand -base64 48` and set it in the environment before deploying.',
      );
    }
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(value);
}

/**
 * Whether the deployment is one where a session cannot outlive a single
 * request handler, and why.
 *
 * Surfaced so the app can say this on screen rather than presenting it as an
 * expired session. "You were signed out" sends somebody to check their
 * password; the real remedy is two environment variables.
 */
export function sessionDurabilityWarning(): string | null {
  if (process.env.AUTH_SECRET && process.env.DATABASE_URL) return null;

  if (isDemoMode()) {
    return (
      'This instance runs in demo mode: the database is in memory and per-instance, so sessions ' +
      'are validated from the signed cookie alone and end on every deploy. Set DATABASE_URL and ' +
      'AUTH_SECRET for sessions that persist.'
    );
  }

  if (!process.env.AUTH_SECRET) {
    return 'AUTH_SECRET is not set, so sessions are signed with a development key.';
  }

  return null;
}

export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db.insert(sessions).values({ userId, expiresAt }).returning();
  if (!row) throw new Error('failed to create session');

  // The email rides along for demo mode only. Each demo instance seeds its own
  // in-memory database, so the user ids differ between instances and a `uid`
  // resolves nowhere but the instance that minted it. The email is the one
  // identifier the seed makes identical everywhere.
  const [account] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  const token = await new SignJWT({ sid: row.id, uid: userId, email: account?.email })
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
  let uid: string;
  let email: string | undefined;
  try {
    const { payload } = await jwtVerify(token, secret());
    sid = payload.sid as string;
    uid = payload.uid as string;
    email = payload.email as string | undefined;
  } catch {
    return null;
  }

  const db = await getDb();

  // The session row is what makes a session revocable server-side, and on a
  // real deployment it is authoritative: no row, no session.
  //
  // A demo instance cannot honour that. Its database is in memory and belongs
  // to one serverless instance, so the row written when somebody signed in does
  // not exist on the instance serving their next click — and requiring it
  // signed people out on every navigation. There, the signed cookie is the
  // whole of the evidence: it is still signed with a key nobody outside the
  // deployment holds, and it still expires. What is lost is revocation, and a
  // demo instance has nothing to revoke access to.
  const demo = isDemoMode();

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1);
  if (!demo) {
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
  } else if (session && session.expiresAt.getTime() < Date.now()) {
    return null;
  }

  const userId = session?.userId ?? uid;

  let [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  // Same instance-boundary problem: the id in the token was minted against
  // another instance's seed. The email is stable across them.
  if (!user && demo && email) {
    [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  }

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
