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
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { getDb, isDemoMode } from '@/lib/db/client';
import { accessGrant, sessions, users, userDivisionAccess } from '@/lib/db/schema';

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
  /**
   * Owns the deployment — connections, mappings, and lending access.
   * Westport holds this; ARG's administrators manage ARG's people.
   */
  isSuperAdmin: boolean;
  /**
   * Capabilities lent to this person and still live.
   *
   * Filtered by expiry and revocation as the session loads, so nothing
   * downstream has to remember to check the clock.
   */
  grantedCapabilities: string[];
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
 * The demo instance's key, when no secret is configured.
 *
 * This used to be a per-process random value, and that was the bug behind
 * "it signs me out when I switch tabs": a demo deployment is many serverless
 * instances, each with its own random key and its own in-memory database. A
 * cookie minted on one instance failed to verify on the next, which the app
 * correctly read as "not signed in" and bounced to the login screen. Every
 * navigation was a coin flip.
 *
 * A fixed key makes the cookie verifiable on any instance, which is the whole
 * point of a stateless token. It is safe *only* under demo mode's own
 * conditions — demo mode requires DATABASE_URL to be unset, so the warehouse is
 * the seeded specimen dataset and there is nothing real to protect. A
 * deployment with a database never reaches this branch, and one running in
 * production without AUTH_SECRET still refuses to start.
 */
const DEMO_FALLBACK_SECRET = 'arg-demo-instance-shared-key-seeded-data-only';

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    if (isDemoMode()) return new TextEncoder().encode(DEMO_FALLBACK_SECRET);
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
 * The claims carried in the token.
 *
 * Identity travels with the cookie as well as living in the database. On a real
 * deployment the database is still the authority — the claims are a fallback the
 * code only reaches for when there is no shared database to be authoritative,
 * which is exactly demo mode. Carrying them costs a few hundred bytes and
 * removes the failure where an ephemeral instance cannot answer "who is this?"
 * for a perfectly valid session.
 */
interface SessionClaims {
  sid: string;
  uid: string;
  email: string;
  name: string;
  role: Role;
  consolidated: boolean;
  divisions: string[];
  superAdmin?: boolean;
}

export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db.insert(sessions).values({ userId, expiresAt }).returning();
  if (!row) throw new Error('failed to create session');

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error('failed to create session: no such user');

  const access = await db
    .select({ divisionCode: userDivisionAccess.divisionCode })
    .from(userDivisionAccess)
    .where(eq(userDivisionAccess.userId, userId));

  const claims: SessionClaims = {
    sid: row.id,
    uid: userId,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    consolidated: user.canViewConsolidated,
    divisions: access.map((a) => a.divisionCode),
    superAdmin: user.isSuperAdmin,
  };

  const token = await new SignJWT({ ...claims })
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

  let claims: SessionClaims;
  try {
    const { payload } = await jwtVerify(token, secret());
    claims = payload as unknown as SessionClaims;
    if (!claims.sid || !claims.uid) return null;
  } catch {
    return null;
  }

  const db = await getDb();

  const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid)).limit(1);

  if (session && session.expiresAt.getTime() >= Date.now()) {
    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (user && user.isActive) return await withAccess(db, user);
    // A revoked or deactivated user is signed out, in every mode.
    return null;
  }

  // No session row. On a shared database that means revoked — refuse.
  if (!isDemoMode()) return null;

  // Demo mode: each instance holds its own in-memory copy of the warehouse, so
  // "the row is not here" carries no information about whether the session is
  // valid. The token's signature already established that. Match the seeded
  // user by email — the seed is deterministic, the row ids are not — and fall
  // back to the token's own claims when even that instance has yet to seed.
  const [seeded] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${claims.email})`)
    .limit(1);

  if (seeded && seeded.isActive) return await withAccess(db, seeded);

  return {
    id: claims.uid,
    email: claims.email,
    name: claims.name,
    role: claims.role,
    canViewConsolidated: claims.consolidated,
    divisionCodes: claims.divisions ?? [],
    // The token carries the role, not lent capabilities: a grant is a database
    // fact and must not survive in a cookie after it is revoked.
    isSuperAdmin: claims.superAdmin ?? false,
    grantedCapabilities: [],
  };
}

async function withAccess(
  db: Awaited<ReturnType<typeof getDb>>,
  user: typeof users.$inferSelect,
): Promise<SessionUser> {
  const access = await db
    .select({ divisionCode: userDivisionAccess.divisionCode })
    .from(userDivisionAccess)
    .where(eq(userDivisionAccess.userId, user.id));

  // Live grants only: never revoked, and either open-ended or not yet expired.
  // An expired grant is invisible rather than filtered later, so a capability
  // check cannot accidentally honour one.
  const grants = await db
    .select({ capability: accessGrant.capability })
    .from(accessGrant)
    .where(
      and(
        eq(accessGrant.userId, user.id),
        isNull(accessGrant.revokedAt),
        or(isNull(accessGrant.expiresAt), gt(accessGrant.expiresAt, new Date())),
      ),
    );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    canViewConsolidated: user.canViewConsolidated,
    divisionCodes: access.map((a) => a.divisionCode),
    isSuperAdmin: user.isSuperAdmin,
    grantedCapabilities: [...new Set(grants.map((grant) => grant.capability))],
  };
}

/** For routes that must have a user. Throws rather than rendering an empty page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  return user;
}
