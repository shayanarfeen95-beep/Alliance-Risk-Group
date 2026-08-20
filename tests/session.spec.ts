/**
 * Sessions across a serverless instance boundary.
 *
 * The reported symptom was "I get logged out when I click any tab". The cause
 * was two things that are both invisible in local development, because locally
 * there is only ever one process:
 *
 *   1. A demo instance signed its tokens with a per-process random key. Vercel
 *      runs many instances of one deployment, so the instance serving the next
 *      click could not verify a token the previous one signed.
 *   2. The session row lived in an in-memory database belonging to that one
 *      instance, so even a shared key would have found no session.
 *
 * Neither reproduces in a single-process test unless the boundary is simulated,
 * which is what this suite does: two databases, two module states, one cookie.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';

/** One serverless instance: its own database and its own module registry. */
async function instance(harness: TestDb) {
  vi.resetModules();

  vi.doMock('@/lib/db/client', async () => {
    const actual = await vi.importActual<typeof import('@/lib/db/client')>('@/lib/db/client');
    return {
      ...actual,
      getDb: async () => harness.db,
      isDemoMode: () => true,
    };
  });

  const store = new Map<string, string>();
  vi.doMock('next/headers', () => ({
    cookies: async () => ({
      get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
      set: (name: string, value: string) => store.set(name, value),
      delete: (name: string) => store.delete(name),
    }),
  }));

  const session = await import('@/lib/auth/session');
  return { session, store };
}

let alpha: TestDb;
let bravo: TestDb;

beforeEach(async () => {
  // Two instances of the same deployment: identical seed, different row ids,
  // exactly as two Vercel lambdas would be.
  alpha = await createTestDb();
  bravo = await createTestDb();
  await seedDatabase(alpha.db, { quiet: true });
  await seedDatabase(bravo.db, { quiet: true });

  process.env.DEMO_MODE = '1';
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_SECRET;
  // What Vercel sets on every instance of one deployment, and what the demo
  // signing key is now derived from.
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test_deployment';
}, 180_000);

afterEach(async () => {
  vi.doUnmock('@/lib/db/client');
  vi.doUnmock('next/headers');
  vi.resetModules();
  delete process.env.VERCEL_DEPLOYMENT_ID;
  delete process.env.DEMO_MODE;
  await alpha?.close();
  await bravo?.close();
});

describe('a demo session survives being served by another instance', () => {
  it('the seed really does produce different user ids per instance', async () => {
    const [one] = await alpha.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'cfo@westportfinancial.com'));
    const [two] = await bravo.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'cfo@westportfinancial.com'));

    // If this ever becomes false the id could be trusted across instances and
    // the email fallback would be dead weight. It is true today.
    expect(one!.id).not.toBe(two!.id);
  });

  it('signs in on one instance and stays signed in on the other', async () => {
    const first = await instance(alpha);
    const [user] = await alpha.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'cfo@westportfinancial.com'));

    await first.session.createSession(user!.id);
    const cookie = first.store.get('arg_session');
    expect(cookie).toBeTruthy();

    // Same person, next click, different lambda.
    const second = await instance(bravo);
    second.store.set('arg_session', cookie!);

    const resolved = await second.session.getSessionUser();

    // Before the fix this was null, and the layout redirected to /login — which
    // is the whole reported bug.
    expect(resolved).not.toBeNull();
    expect(resolved!.email).toBe('cfo@westportfinancial.com');
    expect(resolved!.role).toBe('CFO');
    // Entitlements have to survive the hop too, or a division manager would
    // silently widen or lose their scope on a navigation.
    expect(resolved!.canViewConsolidated).toBe(true);
  });

  it('carries a division manager’s scope across the hop unchanged', async () => {
    const first = await instance(alpha);
    const [manager] = await alpha.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'claims.lead@alliancerisk.com'));

    await first.session.createSession(manager!.id);
    const cookie = first.store.get('arg_session')!;

    const second = await instance(bravo);
    second.store.set('arg_session', cookie);

    const resolved = await second.session.getSessionUser();
    expect(resolved).not.toBeNull();
    expect(resolved!.canViewConsolidated).toBe(false);
    expect(resolved!.divisionCodes).toEqual(['CLAIMS']);
  });

  it('still refuses a cookie signed by a different deployment', async () => {
    const first = await instance(alpha);
    const [user] = await alpha.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'cfo@westportfinancial.com'));
    await first.session.createSession(user!.id);
    const cookie = first.store.get('arg_session')!;

    // A different deployment derives a different key. The relaxation is about
    // instances of one deployment, not about accepting anything signed.
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_someone_elses_deployment';
    const second = await instance(bravo);
    second.store.set('arg_session', cookie);

    expect(await second.session.getSessionUser()).toBeNull();
  });

  it('refuses a garbage cookie rather than throwing', async () => {
    const only = await instance(alpha);
    only.store.set('arg_session', 'not-a-jwt');
    expect(await only.session.getSessionUser()).toBeNull();
  });
});

describe('a real deployment keeps server-side revocation', () => {
  it('a deleted session row signs the user out', async () => {
    // Not demo mode: the session row is authoritative, and deleting it is how
    // an administrator throws somebody out.
    vi.resetModules();
    vi.doMock('@/lib/db/client', async () => {
      const actual = await vi.importActual<typeof import('@/lib/db/client')>('@/lib/db/client');
      return { ...actual, getDb: async () => alpha.db, isDemoMode: () => false };
    });

    const store = new Map<string, string>();
    vi.doMock('next/headers', () => ({
      cookies: async () => ({
        get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
        set: (name: string, value: string) => store.set(name, value),
        delete: (name: string) => store.delete(name),
      }),
    }));

    process.env.AUTH_SECRET = 'a-real-secret-that-is-long-enough-for-hs256-signing';
    const session = await import('@/lib/auth/session');

    const [user] = await alpha.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'cfo@westportfinancial.com'));

    await session.createSession(user!.id);
    expect(await session.getSessionUser()).not.toBeNull();

    await alpha.db.delete(t.sessions);
    expect(await session.getSessionUser()).toBeNull();

    delete process.env.AUTH_SECRET;
  });
});
