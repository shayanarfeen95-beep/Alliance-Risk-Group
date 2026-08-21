/**
 * Super admin, and access lent rather than given away.
 *
 * The rules worth testing are the ones that keep a temporary permission
 * temporary: an expired grant must be invisible, a revoked one must stop
 * working, and lending must not itself be lendable — otherwise one grant
 * quietly becomes an org chart nobody wrote.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { can, capabilitySource, DELEGABLE_CAPABILITIES } from '@/lib/auth/scope';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let westport: SessionUser;
let claimsManager: SessionUser;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  westport = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  claimsManager = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** Rebuilds a session the way `getSessionUser` does, grants included. */
async function reload(user: SessionUser): Promise<SessionUser> {
  const grants = await harness.db
    .select()
    .from(t.accessGrant)
    .where(eq(t.accessGrant.userId, user.id));

  const live = grants.filter(
    (grant) =>
      grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > new Date()),
  );

  return { ...user, grantedCapabilities: live.map((grant) => grant.capability) };
}

describe('the super admin', () => {
  it('is Westport, and holds everything including the deployment', () => {
    expect(westport.isSuperAdmin).toBe(true);
    expect(can(westport, 'DELEGATE_ACCESS')).toBe(true);
    expect(can(westport, 'MANAGE_CONNECTIONS')).toBe(true);
  });

  it('is not something a division manager becomes by accident', () => {
    expect(claimsManager.isSuperAdmin).toBe(false);
    expect(can(claimsManager, 'DELEGATE_ACCESS')).toBe(false);
    expect(can(claimsManager, 'CLOSE_PERIOD')).toBe(false);
  });
});

describe('a lent capability', () => {
  it('works while it is live, and says where it came from', async () => {
    await harness.db.insert(t.accessGrant).values({
      userId: claimsManager.id,
      capability: 'CLOSE_PERIOD',
      grantedBy: westport.id,
      reason: 'Covering the March close',
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });

    const withGrant = await reload(claimsManager);
    expect(can(withGrant, 'CLOSE_PERIOD')).toBe(true);
    // The screen has to be able to explain itself: this is lent, not theirs.
    expect(capabilitySource(withGrant, 'CLOSE_PERIOD')).toBe('granted');
    expect(capabilitySource(withGrant, 'LOCK_FORECAST')).toBe('role');
  });

  it('stops working the moment it expires', async () => {
    await harness.db.insert(t.accessGrant).values({
      userId: claimsManager.id,
      capability: 'RUN_INGESTION',
      grantedBy: westport.id,
      reason: 'One-off backfill',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const reloaded = await reload(claimsManager);
    expect(can(reloaded, 'RUN_INGESTION')).toBe(false);
  });

  it('stops working when it is revoked, and the record survives', async () => {
    const [grant] = await harness.db
      .insert(t.accessGrant)
      .values({
        userId: claimsManager.id,
        capability: 'SIGN_COMMENTARY',
        grantedBy: westport.id,
        reason: 'Signing while Ryan is away',
      })
      .returning();

    expect(can(await reload(claimsManager), 'SIGN_COMMENTARY')).toBe(true);

    await harness.db
      .update(t.accessGrant)
      .set({ revokedAt: new Date(), revokedBy: westport.id })
      .where(eq(t.accessGrant.id, grant!.id));

    expect(can(await reload(claimsManager), 'SIGN_COMMENTARY')).toBe(false);

    // Revoking is a timestamp, not a delete: who could do what, and when, is
    // the reason the table exists.
    const [after] = await harness.db
      .select()
      .from(t.accessGrant)
      .where(eq(t.accessGrant.id, grant!.id));
    expect(after).toBeDefined();
    expect(after!.reason).toBe('Signing while Ryan is away');
    expect(after!.revokedBy).toBe(westport.id);
  });

  it('cannot be used to lend more', async () => {
    // Even holding every delegable capability, the recipient cannot delegate.
    const holdingEverything: SessionUser = {
      ...claimsManager,
      grantedCapabilities: [...DELEGABLE_CAPABILITIES],
    };

    expect(can(holdingEverything, 'MANAGE_USERS')).toBe(true);
    expect(can(holdingEverything, 'DELEGATE_ACCESS')).toBe(false);
    // Nor to take over the deployment's own connections.
    expect(can(holdingEverything, 'MANAGE_CONNECTIONS')).toBe(false);
  });

  it('never widens what divisions somebody can see', async () => {
    const withGrant = await reload(claimsManager);
    // A grant is about actions, not about data scope. Entitlements are a
    // separate axis and stay where they were.
    expect(withGrant.divisionCodes).toEqual(claimsManager.divisionCodes);
    expect(withGrant.canViewConsolidated).toBe(false);
  });
});
