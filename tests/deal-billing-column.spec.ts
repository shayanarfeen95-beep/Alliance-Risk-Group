/**
 * The Billed column beside Amount on the Leadership deal lists.
 *
 * Westport, November 2026: "an additional column of billed compared to booked
 * … ACTUAL billed with ability to adjust time-period or have a YTD period."
 * Billing is the account's, so the index maps each won deal to its account,
 * and the period is totalled from the account's invoice days.
 */
import { describe, expect, it } from 'vitest';
import { billedIn, toDealBillingIndex } from '@/lib/dashboards/deal-rows';

const index = toDealBillingIndex(
  {
    asOf: '2026-11-05',
    unavailable: null,
    rows: [
      {
        key: 'co1',
        account: 'Acme',
        wonOn: '2026-04-07',
        booked: 75_000,
        deals: [{ id: 'd1' }, { id: 'd2' }],
        match: { method: 'DOMAIN', customerId: 'C1', customerName: '10229 - Acme Inc' },
        invoiceDays: [
          { date: '2025-12-15', billed: 1_000 },
          { date: '2026-03-02', billed: 500 },
          { date: '2026-06-10', billed: 915 },
          { date: '2026-07-01', billed: 674 },
          { date: '2026-09-04', billed: 530 },
        ],
      },
      {
        key: 'co2',
        account: 'Nomatch',
        wonOn: '2026-10-19',
        booked: 100_000,
        deals: [{ id: 'd3' }],
        match: { method: 'NONE', customerId: null, customerName: null },
        invoiceDays: [],
      },
    ],
  },
  '2025-01-01',
);

describe('the Billed column', () => {
  it('finds the account behind each won deal, and says when there is no customer', () => {
    expect(index.accountOf).toEqual({ d1: 'co1', d2: 'co1', d3: 'co2' });
    expect(index.accounts.co1).toMatchObject({ customer: '10229 - Acme Inc', confirmed: false, dealCount: 2 });
    expect(index.accounts.co2!.customer).toBeNull();
  });

  it('totals since won, year to date, or the months chosen', () => {
    const acme = index.accounts.co1!;
    // Since won 2026-04-07: the March invoice is before the win.
    expect(billedIn(acme, { kind: 'since_won' }, index.asOf)).toBe(2_119);
    // Year to date 2026: March counts, December 2025 does not.
    expect(billedIn(acme, { kind: 'ytd' }, index.asOf)).toBe(2_619);
    // Whole months, both ends included.
    expect(billedIn(acme, { kind: 'custom', from: '2025-12', to: '2026-06' }, index.asOf)).toBe(2_415);
  });
});
