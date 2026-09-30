/**
 * What a dashboard view reads from the database.
 *
 * Every page opens a fact bundle, so every row it selects crosses the wire on
 * every view. Reading HubSpot's contacts and companies whole — tens of
 * thousands of each at ARG — ran the free Neon plan out of data transfer and
 * took the site down, sign-in page included. The bundle now reads only rows
 * that can move a figure: contacts with a lifecycle date inside the window the
 * dashboards reach, and companies a deal names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { loadFactBundle } from '@/lib/semantic/facts';
import { buildPeriodContext } from '@/lib/semantic/periods';
import * as t from '@/lib/db/schema';

let harness: TestDb;
const MONTH = '2026-03-01';

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);

  await harness.db.insert(t.factContact).values([
    // Became a lead years before anything a dashboard can show.
    { contactId: 'old-lead', divisionCode: 'SHRC', becameLeadDate: new Date('2019-05-10T00:00:00Z') },
    // No lifecycle date at all: counted by nothing.
    { contactId: 'no-dates', divisionCode: 'SHRC' },
    // Became a customer in the reporting month, lead long before.
    {
      contactId: 'recent-customer',
      divisionCode: 'SHRC',
      becameLeadDate: new Date('2019-01-10T00:00:00Z'),
      becameCustomerDate: new Date('2026-03-12T00:00:00Z'),
    },
    // Inside the window but in a division the caller may not see.
    { contactId: 'other-division', divisionCode: 'CLAIMS', becameLeadDate: new Date('2026-03-05T00:00:00Z') },
  ]);

  await harness.db.insert(t.factCompany).values([
    { companyId: 'named-by-deal', name: 'Acme Fleet', icpTier: 'Tier 1' },
    { companyId: 'never-named', name: 'Nobody Inc', icpTier: 'Tier 2' },
  ]);
  await harness.db.insert(t.factDeal).values({
    dealId: 'deal-with-company',
    divisionCode: 'SHRC',
    dealName: 'Acme renewal',
    amount: '5000',
    isClosedWon: true,
    isClosed: true,
    closedate: new Date('2026-03-20T00:00:00Z'),
    companyId: 'named-by-deal',
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('fact bundle reads', () => {
  it('reads only contacts with a lifecycle date inside the window, in scope', async () => {
    const bundle = await loadFactBundle(harness.db, buildPeriodContext(MONTH), ['SHRC']);
    const ids = new Set(bundle.contacts.map((contact) => contact.contactId));

    expect(ids.has('recent-customer')).toBe(true);
    expect(ids.has('old-lead')).toBe(false);
    expect(ids.has('no-dates')).toBe(false);
    expect(ids.has('other-division')).toBe(false);
    // The seeded contacts for the month are still there.
    expect(bundle.contacts.length).toBeGreaterThan(1);
  });

  it('reads only companies a deal names', async () => {
    const bundle = await loadFactBundle(harness.db, buildPeriodContext(MONTH), ['SHRC']);
    const ids = new Set(bundle.companies.map((company) => company.companyId));

    expect(ids.has('named-by-deal')).toBe(true);
    expect(ids.has('never-named')).toBe(false);
  });

  it('keeps deals in scope whatever their age, and drops other divisions', async () => {
    const bundle = await loadFactBundle(harness.db, buildPeriodContext(MONTH), ['SHRC']);

    expect(bundle.deals.some((deal) => deal.dealId === 'deal-with-company')).toBe(true);
    expect(bundle.deals.every((deal) => deal.divisionCode === null || deal.divisionCode === 'SHRC')).toBe(true);
  });
});
