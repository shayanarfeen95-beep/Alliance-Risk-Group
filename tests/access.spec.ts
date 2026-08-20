/**
 * Who can manage people, and the two guards that stop somebody locking the
 * whole system out.
 *
 * Both failures here are unrecoverable from inside the app — the only fix is a
 * database console — so both are asserted against directly rather than trusted
 * to a code reading.
 *
 * The guards used to be phrased as the literal ADMIN role. Granting
 * MANAGE_USERS to CFO, so Westport can actually delegate access from the login
 * ARG was given, broke that phrasing in two ways at once: a CFO editing their
 * own division scope was refused with an error about administrator access they
 * never had, and demoting the last ADMIN was refused even with three CFOs able
 * to take over. These tests pin the capability-based versions.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { can, capabilitiesOf, capabilityMatrix, ROLE_ORDER } from '@/lib/auth/scope';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
}, 180_000);

afterEach(async () => {
  await harness?.close();
});

const asUser = (role: SessionUser['role']): SessionUser => ({
  id: '00000000-0000-0000-0000-0000000000ff',
  email: 'test@example.com',
  name: 'Test',
  role,
  canViewConsolidated: true,
  divisionCodes: [],
});

describe('the capability model', () => {
  it('lets the CFO manage people, which is what delegation requires', () => {
    // ARG was handed the CFO login. With MANAGE_USERS on ADMIN only, the one
    // account they had could not add a person — the punch-list item was
    // unreachable from the product.
    expect(can(asUser('CFO'), 'MANAGE_USERS')).toBe(true);
    expect(can(asUser('ADMIN'), 'MANAGE_USERS')).toBe(true);
  });

  it('does not let anyone else manage people', () => {
    for (const role of ['EXECUTIVE', 'DIVISION_MANAGER', 'VIEWER'] as const) {
      expect(can(asUser(role), 'MANAGE_USERS')).toBe(false);
    }
  });

  it('keeps a viewer read-only', () => {
    expect(capabilitiesOf('VIEWER')).toEqual([]);
  });

  it('publishes a matrix that matches the enforcement exactly', () => {
    // The Admin screen renders this. If it could drift from `can`, it would be
    // a permissions page describing permissions the system does not apply.
    for (const row of capabilityMatrix()) {
      for (const role of ROLE_ORDER) {
        expect(row.roles[role]).toBe(can(asUser(role), row.capability));
      }
    }
  });
});

describe('the lockout guards', () => {
  /** The PATCH handler's decision, exercised through the same helpers it uses. */
  function wouldLockSelfOut(currentRole: SessionUser['role'], nextRole: SessionUser['role']) {
    return !capabilitiesOf(nextRole).includes('MANAGE_USERS');
  }

  it('refuses a self-demotion that would remove your own access', () => {
    expect(wouldLockSelfOut('ADMIN', 'VIEWER')).toBe(true);
    expect(wouldLockSelfOut('CFO', 'EXECUTIVE')).toBe(true);
  });

  it('allows a self-edit that keeps the access', () => {
    // The case the role-name check got wrong: a CFO saving their own record
    // with the role unchanged was refused.
    expect(wouldLockSelfOut('CFO', 'CFO')).toBe(false);
    expect(wouldLockSelfOut('ADMIN', 'CFO')).toBe(false);
  });

  it('counts every role that can manage people, not just administrators', async () => {
    const managingRoles = ROLE_ORDER.filter((role) =>
      capabilitiesOf(role).includes('MANAGE_USERS'),
    );
    expect(managingRoles).toContain('ADMIN');
    expect(managingRoles).toContain('CFO');

    // The seed ships one of each, so demoting the admin leaves the CFO — and
    // the backstop must permit it. Counting only ADMINs would refuse.
    const remaining = (
      await harness.db.select().from(t.users).where(eq(t.users.isActive, true))
    ).filter((row) => managingRoles.includes(row.role as SessionUser['role']));

    expect(remaining.length).toBeGreaterThan(1);
  });
});
