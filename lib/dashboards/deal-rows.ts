import type { DealRecord } from '@/lib/semantic/facts';

/**
 * A deal as a person reads it: names, not ids.
 *
 * What a drill-down lists when somebody clicks a bar — the reason the review
 * can be read here instead of in HubSpot. Shared by every chart, so a deal
 * reads the same wherever it is opened from.
 */
export interface DealRow {
  id: string;
  name: string;
  company: string | null;
  /** The deal owner: who closed it, for a won deal. */
  owner: string;
  amount: number;
  stage: string;
  status: 'Won' | 'Lost' | 'Open';
  created: string | null;
  closed: string | null;
  /** Date Compliance Review Completed. */
  reviewed: string | null;
  /**
   * When it is expected to close: HubSpot's Estimated Close Date, or, on an
   * open deal, its Close Date (which HubSpot uses as the expected date).
   */
  expectedClose: string | null;
  source: string;
  lineOfBusiness: string | null;
  createdBy: string | null;
  /** Every stage the deal entered, oldest first — "where they are in stages". */
  stageHistory: Array<{ stage: string; entered: string }>;
  /** Days since it entered the stage it is in now. */
  daysInStage: number | null;
}

/** Deal id → its stage entries, oldest first, with stage names. */
export function stageHistoryIndex(
  entries: Array<{ dealId: string; stage: string; enteredAt: Date }>,
  stageLabel: (stageId: string | null) => string,
): Map<string, Array<{ stage: string; entered: string }>> {
  const byDeal = new Map<string, Array<{ stage: string; at: Date }>>();
  for (const entry of entries) {
    const list = byDeal.get(entry.dealId) ?? [];
    list.push({ stage: entry.stage, at: entry.enteredAt });
    byDeal.set(entry.dealId, list);
  }
  const out = new Map<string, Array<{ stage: string; entered: string }>>();
  for (const [dealId, list] of byDeal) {
    out.set(
      dealId,
      list
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((item) => ({ stage: stageLabel(item.stage), entered: item.at.toISOString().slice(0, 10) })),
    );
  }
  return out;
}

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export function toDealRow(
  deal: DealRecord,
  stageLabel: (stageId: string | null) => string,
  companyName: (companyId: string | null) => string | null,
  history?: Map<string, Array<{ stage: string; entered: string }>>,
  today: Date = new Date(),
): DealRow {
  const stageHistory = history?.get(deal.dealId) ?? [];
  const current = stageLabel(deal.dealstage);
  const enteredCurrent = [...stageHistory].reverse().find((entry) => entry.stage === current)?.entered ?? null;
  return {
    stageHistory,
    daysInStage: enteredCurrent
      ? Math.max(0, Math.floor((today.getTime() - new Date(`${enteredCurrent}T00:00:00Z`).getTime()) / 86_400_000))
      : null,
    id: deal.dealId,
    name: deal.dealName ?? `Deal ${deal.dealId}`,
    company: companyName(deal.companyId),
    owner: deal.ownerName ?? 'Unassigned',
    amount: deal.amount.toNumber(),
    stage: stageLabel(deal.dealstage),
    status: deal.isClosedWon ? 'Won' : deal.isClosed ? 'Lost' : 'Open',
    created: day(deal.createdate),
    closed: deal.isClosed ? day(deal.closedate) : null,
    reviewed: day(deal.complianceReviewCompletedAt),
    expectedClose: day(deal.estimatedCloseDate ?? (deal.isClosed ? null : deal.closedate)),
    source: deal.sourceLabel ?? 'Not recorded',
    lineOfBusiness: deal.lineOfBusiness,
    createdBy: deal.createdByName,
  };
}

/** Company id → name, from the companies loaded with the bundle. */
export function companyNames(
  companies: Array<{ companyId: string; name: string | null }>,
): (companyId: string | null) => string | null {
  const byId = new Map(companies.map((company) => [company.companyId, company.name]));
  return (companyId) => (companyId ? (byId.get(companyId) ?? null) : null);
}

/**
 * What QuickBooks has billed the account behind each won deal.
 *
 * Westport, November 2026: "have an additional column of billed compared to
 * booked … next to Amount, and put ACTUAL billed, with the ability to adjust
 * the time period or have a YTD period." Billing belongs to the account, not to
 * one deal, so a deal list looks its account up here; the invoice days travel
 * with it, so any period is totalled in the browser without asking again.
 * Built from the Account billing comparison, so the two cannot disagree.
 */
export interface DealBilling {
  account: string;
  /** The QuickBooks customer, or null when none is matched. */
  customer: string | null;
  /** False while the match is only suggested (by domain or name). */
  confirmed: boolean;
  /** The account's first win: where "since won" starts. */
  wonOn: string;
  /** Every won deal of the account, booked. */
  booked: number;
  dealCount: number;
  /** [day, billed] — net of credit memos, sales tax excluded. Oldest first. */
  invoiceDays: Array<[string, number]>;
}

export interface DealBillingIndex {
  /** Today, as the billing was read. */
  asOf: string;
  /** The first month invoices were read for. */
  horizon: string;
  accounts: Record<string, DealBilling>;
  /** Deal id → account key. */
  accountOf: Record<string, string>;
  unavailable: string | null;
}

export function toDealBillingIndex(
  model: {
    asOf: string;
    unavailable: string | null;
    rows: Array<{
      key: string;
      account: string;
      wonOn: string;
      booked: number;
      deals: Array<{ id: string }>;
      match: { method: string; customerName: string | null; customerId: string | null };
      invoiceDays: Array<{ date: string; billed: number }>;
    }>;
  },
  horizon: string,
): DealBillingIndex {
  const accounts: DealBillingIndex['accounts'] = {};
  const accountOf: DealBillingIndex['accountOf'] = {};
  for (const row of model.rows) {
    accounts[row.key] = {
      account: row.account,
      customer: row.match.customerId ? row.match.customerName : null,
      confirmed: row.match.method === 'CONFIRMED',
      wonOn: row.wonOn,
      booked: row.booked,
      dealCount: row.deals.length,
      invoiceDays: row.invoiceDays.map((invoice) => [invoice.date, invoice.billed]),
    };
    for (const deal of row.deals) accountOf[deal.id] = row.key;
  }
  return { asOf: model.asOf, horizon, accounts, accountOf, unavailable: model.unavailable };
}

export type BillingPeriod =
  | { kind: 'since_won' }
  | { kind: 'ytd' }
  | { kind: 'custom'; from: string; to: string };

/** What the account billed in the period: days inclusive, months whole. */
export function billedIn(billing: DealBilling, period: BillingPeriod, asOf: string): number {
  const [from, to] =
    period.kind === 'since_won'
      ? [billing.wonOn, asOf]
      : period.kind === 'ytd'
        ? [`${asOf.slice(0, 4)}-01-01`, asOf]
        : [`${period.from.slice(0, 7)}-01`, `${period.to.slice(0, 7)}-31`];
  let total = 0;
  for (const [day, billed] of billing.invoiceDays) {
    if (day >= from && day <= to) total += billed;
  }
  return Math.round(total * 100) / 100;
}
