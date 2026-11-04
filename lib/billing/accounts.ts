import 'server-only';
import Decimal from 'decimal.js';
import { and, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SemanticSession } from '@/lib/semantic/resolve';
import type { DealRecord } from '@/lib/semantic/facts';
import { hasOption } from '@/lib/connectors/hubspot-fields';

/**
 * Booked against billed, account by account.
 *
 * Westport, November 2026: "determine which accounts have started billing in
 * QuickBooks compared to what is closed/won", and "if an account has gone live
 * and we anticipate it billing $100K for the 12 month period, we would like
 * live reporting of progress — and eventually alerts to the Account Manager or
 * Sales Leader."
 *
 * HubSpot knows the deal: who, how much, when it was won and when it went live.
 * QuickBooks knows the invoices: who was billed, how much, when. Nothing in
 * either system says which QuickBooks customer a HubSpot company is, so that
 * link is made here in three steps, strongest first:
 *
 *   1. A person's decision in Admin → Account matching — always wins.
 *   2. A shared domain: the HubSpot company's domain is the QuickBooks
 *      customer's website or email domain.
 *   3. The same name, once case, punctuation and "Inc"/"LLC" are set aside.
 *
 * A match by domain or name is counted, and says how it was made, so Westport
 * can confirm or correct it. Anything weaker is only offered as a suggestion and
 * counts nothing: a booking credited with another customer's invoices is worse
 * than one shown as unmatched.
 *
 * Progress is measured against a straight-line year: the deal's amount is the
 * value expected over the twelve months after it goes live, so three months in,
 * a quarter of it should have billed. That is the assumption Westport stated;
 * it is printed on the page, and the term is a parameter.
 */

export const CONTRACT_MONTHS = 12;
/** Days after go-live before an account with no invoice is flagged. */
export const FIRST_INVOICE_GRACE_DAYS = 45;
/** Below this share of the expected-to-date amount, an account is behind pace. */
export const BEHIND_PACE = 0.75;
/** Above this share, it is ahead. */
export const AHEAD_OF_PACE = 1.25;

export type MatchMethod = 'CONFIRMED' | 'DOMAIN' | 'NAME' | 'NONE' | 'REJECTED';

export type BillingStatus =
  | 'NO_MATCH'
  | 'WAITING'
  | 'NOT_BILLING'
  | 'BEHIND'
  | 'ON_PACE'
  | 'AHEAD'
  | 'REACHED';

export const STATUS_LABEL: Record<BillingStatus, string> = {
  NO_MATCH: 'No QuickBooks customer',
  WAITING: 'Waiting for first invoice',
  NOT_BILLING: 'Not billing',
  BEHIND: 'Behind pace',
  ON_PACE: 'On pace',
  AHEAD: 'Ahead of pace',
  REACHED: 'Contract value billed',
};

export interface CustomerOption {
  id: string;
  name: string;
}

export interface AccountMatch {
  method: MatchMethod;
  customerId: string | null;
  customerName: string | null;
  /** Weaker candidates, offered in Admin and never counted. */
  suggestions: CustomerOption[];
}

export interface AccountDeal {
  id: string;
  name: string;
  owner: string;
  amount: number;
  closed: string;
  goLive: string;
  stage: string;
  lineOfBusiness: string | null;
}

export interface AccountBillingRow {
  key: string;
  companyId: string | null;
  account: string;
  owners: string[];
  deals: AccountDeal[];
  lineOfBusiness: string | null;
  wonOn: string;
  goLiveOn: string;
  booked: number;
  /** What a straight-line year says should have billed by now. */
  expectedToDate: number;
  billedSinceWon: number;
  billedLast30Days: number;
  /** Billed in the twelve months before the first win — an existing customer. */
  billedBeforeWon: number;
  invoiceCount: number;
  firstInvoice: string | null;
  lastInvoice: string | null;
  pctOfExpected: number | null;
  pctOfContract: number | null;
  status: BillingStatus;
  match: AccountMatch;
  /** Billed per month from the month won to now. */
  monthly: Array<{ month: string; billed: number }>;
}

export interface AccountBilling {
  asOf: string;
  rows: AccountBillingRow[];
  totals: {
    accounts: number;
    matched: number;
    billing: number;
    booked: number;
    expectedToDate: number;
    billedSinceWon: number;
    needAttention: number;
  };
  /** Accounts behind pace or not billing, by the person who owns them. */
  alerts: Array<{ owner: string; rows: Array<{ key: string; account: string; status: BillingStatus; detail: string }> }>;
  /** Set when QuickBooks billing has not been loaded at all. */
  unavailable: string | null;
}

export interface AccountBillingOptions {
  /** Deals won on or after this day. */
  wonFrom: Date;
  /** Deals won before this day. */
  wonTo: Date;
  lineOfBusiness?: string | null;
  /** "Now", for pace. Defaults to the moment of the call. */
  asOf?: Date;
}

// ---------------------------------------------------------------------------
// Names and matching
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l', 'c', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'the', 'pllc', 'pc', 'lp', 'llp', 'plc', 'pa',
]);

/** "The Acme Company, LLC" → "acme". Words, not characters, so "Acme Co" ≠ "Acmeco". */
export function normaliseName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !LEGAL_SUFFIXES.has(word))
    .join(' ');
}

/** "Acme Corp - New Deal" → "Acme Corp": the account a deal name starts with. */
function accountPartOfDealName(dealName: string | null): string {
  if (!dealName) return '';
  return dealName.split(/\s+[-–—|:]\s*|\s*[-–—|:]\s+/)[0] ?? dealName;
}

interface CustomerRow {
  customerId: string;
  displayName: string;
  companyName: string | null;
  fullyQualifiedName: string | null;
  parentId: string | null;
  emailDomain: string | null;
  webDomain: string | null;
}

/** The top of a customer's tree: a job is billed as part of its customer. */
function topOf(id: string, byId: Map<string, CustomerRow>): string {
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
    seen.add(current.customerId);
    current = byId.get(current.parentId);
  }
  return current?.customerId ?? id;
}

export function suggestMatch(
  company: { name: string | null; domain: string | null; dealNames: string[] },
  customers: CustomerRow[],
  byId: Map<string, CustomerRow>,
): Omit<AccountMatch, 'method'> & { method: 'DOMAIN' | 'NAME' | 'NONE' } {
  const nameOf = (id: string) => byId.get(id)?.displayName ?? id;
  const unique = (ids: string[]) => [...new Set(ids.map((id) => topOf(id, byId)))];

  const domain = company.domain?.toLowerCase().replace(/^www\./, '') ?? null;
  if (domain) {
    const hits = unique(
      customers
        .filter((customer) => customer.webDomain === domain || customer.emailDomain === domain)
        .map((customer) => customer.customerId),
    );
    if (hits.length === 1) {
      return { method: 'DOMAIN', customerId: hits[0]!, customerName: nameOf(hits[0]!), suggestions: [] };
    }
  }

  const wanted = new Set(
    [company.name, ...company.dealNames.map(accountPartOfDealName)].map(normaliseName).filter(Boolean),
  );
  const namesOf = (customer: CustomerRow) =>
    [customer.displayName, customer.companyName, customer.fullyQualifiedName?.split(':')[0]]
      .map(normaliseName)
      .filter(Boolean);

  const exact = unique(
    customers.filter((customer) => namesOf(customer).some((name) => wanted.has(name))).map((c) => c.customerId),
  );
  if (exact.length === 1) {
    return { method: 'NAME', customerId: exact[0]!, customerName: nameOf(exact[0]!), suggestions: [] };
  }

  // Weaker: every word of the shorter name appears in the longer one. Offered,
  // never counted.
  const words = (value: string) => new Set(value.split(' ').filter((word) => word.length > 1));
  const loose = unique(
    customers
      .filter((customer) =>
        namesOf(customer).some((name) =>
          [...wanted].some((target) => {
            const a = words(name);
            const b = words(target);
            const [small, large] = a.size <= b.size ? [a, b] : [b, a];
            if (small.size === 0 || [...small].join('').length < 5) return false;
            return [...small].every((word) => large.has(word));
          }),
        ),
      )
      .map((c) => c.customerId),
  );
  const candidates = [...new Set([...exact, ...loose])].slice(0, 5);
  return {
    method: 'NONE',
    customerId: null,
    customerName: null,
    suggestions: candidates.map((id) => ({ id, name: nameOf(id) })),
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const day = (value: Date) => value.toISOString().slice(0, 10);
const monthOf = (value: string) => `${value.slice(0, 7)}-01`;
const DAY_MS = 86_400_000;
const MONTH_DAYS = 365.25 / 12;

/** When a deal went live: the first time it entered a stage named "live", else its close date. */
function goLiveOf(deal: DealRecord, session: SemanticSession): Date {
  const liveStages = new Set(
    session.bundle.dealStages.filter((stage) => /live/i.test(stage.label)).map((stage) => stage.stageId),
  );
  const entries = session.bundle.stageEntries
    .filter((entry) => entry.dealId === deal.dealId && liveStages.has(entry.stage))
    .map((entry) => entry.enteredAt)
    .sort((a, b) => a.getTime() - b.getTime());
  return entries[0] ?? deal.closedate!;
}

export async function loadAccountBilling(
  db: Database,
  session: SemanticSession,
  options: AccountBillingOptions,
): Promise<AccountBilling> {
  const { bundle } = session;
  const asOf = options.asOf ?? new Date();
  const stageLabel = new Map(bundle.dealStages.map((stage) => [stage.stageId, stage.label]));

  const won = bundle.deals.filter(
    (deal) =>
      deal.isClosedWon &&
      deal.closedate !== null &&
      deal.closedate >= options.wonFrom &&
      deal.closedate < options.wonTo &&
      (!options.lineOfBusiness || hasOption(deal.lineOfBusiness, options.lineOfBusiness)),
  );

  // --- QuickBooks reference data -----------------------------------------
  const [customers, invoiceCount, decisions] = await Promise.all([
    db
      .select({
        customerId: t.dimQboCustomer.customerId,
        displayName: t.dimQboCustomer.displayName,
        companyName: t.dimQboCustomer.companyName,
        fullyQualifiedName: t.dimQboCustomer.fullyQualifiedName,
        parentId: t.dimQboCustomer.parentId,
        emailDomain: t.dimQboCustomer.emailDomain,
        webDomain: t.dimQboCustomer.webDomain,
      })
      .from(t.dimQboCustomer),
    db.select({ n: sql<number>`count(*)::int` }).from(t.factInvoice),
    db.select().from(t.mapCompanyCustomer),
  ]);
  const byId = new Map(customers.map((customer) => [customer.customerId, customer]));
  const decided = new Map(decisions.map((row) => [row.companyId, row.qboCustomerId]));

  const unavailable =
    customers.length === 0 || Number(invoiceCount[0]?.n ?? 0) === 0
      ? 'QuickBooks invoices have not been loaded yet, so no account can be compared with what it has billed. ' +
        'Pull QuickBooks — the “Customers” and “Invoices and credit memos” steps — in Admin → Data & pulls.'
      : null;

  // --- HubSpot accounts ---------------------------------------------------
  const companyIds = [...new Set(won.map((deal) => deal.companyId).filter((id): id is string => Boolean(id)))];
  const companies = companyIds.length
    ? await db
        .select({ companyId: t.factCompany.companyId, name: t.factCompany.name, domain: t.factCompany.domain })
        .from(t.factCompany)
        .where(inArray(t.factCompany.companyId, companyIds))
    : [];
  const companyById = new Map(companies.map((company) => [company.companyId, company]));

  const groups = new Map<string, DealRecord[]>();
  for (const deal of won) {
    const key = deal.companyId ?? `deal:${deal.dealId}`;
    groups.set(key, [...(groups.get(key) ?? []), deal]);
  }

  // Match every account first, so invoices are read only for the customers
  // that matter rather than for the whole ledger.
  const matches = new Map<string, AccountMatch>();
  for (const [key, deals] of groups) {
    const companyId = deals[0]!.companyId;
    const company = companyId ? companyById.get(companyId) : undefined;
    if (companyId && decided.has(companyId)) {
      const customerId = decided.get(companyId) ?? null;
      matches.set(key, {
        method: customerId ? 'CONFIRMED' : 'REJECTED',
        customerId,
        customerName: customerId ? (byId.get(customerId)?.displayName ?? customerId) : null,
        suggestions: [],
      });
      continue;
    }
    matches.set(
      key,
      suggestMatch(
        { name: company?.name ?? null, domain: company?.domain ?? null, dealNames: deals.map((deal) => deal.dealName ?? '') },
        customers,
        byId,
      ),
    );
  }

  // A customer's billing includes its sub-customers.
  const children = new Map<string, string[]>();
  for (const customer of customers) {
    if (!customer.parentId) continue;
    children.set(customer.parentId, [...(children.get(customer.parentId) ?? []), customer.customerId]);
  }
  const subtree = (id: string): string[] => {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (out.includes(next)) continue;
      out.push(next);
      stack.push(...(children.get(next) ?? []));
    }
    return out;
  };

  const matchedIds = [...new Set([...matches.values()].map((match) => match.customerId).filter((id): id is string => Boolean(id)))];
  const treeOf = new Map(matchedIds.map((id) => [id, subtree(id)]));
  const allIds = [...new Set([...treeOf.values()].flat())];

  const earliestWon = won.reduce<Date | null>(
    (min, deal) => (!min || deal.closedate! < min ? deal.closedate! : min),
    null,
  );
  const since = earliestWon ? new Date(earliestWon.getTime() - 366 * DAY_MS) : asOf;

  const invoiceRows = allIds.length
    ? await db
        .select({
          customerId: t.factInvoice.customerId,
          txnDate: t.factInvoice.txnDate,
          billed: sql<string>`sum(${t.factInvoice.billed})`,
          count: sql<number>`count(*)::int`,
        })
        .from(t.factInvoice)
        .where(and(inArray(t.factInvoice.customerId, allIds), gte(t.factInvoice.txnDate, day(since))))
        .groupBy(t.factInvoice.customerId, t.factInvoice.txnDate)
    : [];

  const invoicesOf = new Map<string, Array<{ date: string; billed: Decimal; count: number }>>();
  for (const row of invoiceRows) {
    const date = typeof row.txnDate === 'string' ? row.txnDate.slice(0, 10) : day(row.txnDate as unknown as Date);
    invoicesOf.set(row.customerId, [
      ...(invoicesOf.get(row.customerId) ?? []),
      { date, billed: new Decimal(row.billed ?? 0), count: Number(row.count) },
    ]);
  }

  // --- One row per account ------------------------------------------------
  const rows: AccountBillingRow[] = [];
  for (const [key, deals] of groups) {
    const match = matches.get(key)!;
    const companyId = deals[0]!.companyId;
    const company = companyId ? companyById.get(companyId) : undefined;

    const accountDeals: AccountDeal[] = deals.map((deal) => ({
      id: deal.dealId,
      name: deal.dealName ?? `Deal ${deal.dealId}`,
      owner: deal.ownerName ?? 'Unassigned',
      amount: deal.amount.toNumber(),
      closed: day(deal.closedate!),
      goLive: day(goLiveOf(deal, session)),
      stage: deal.dealstage ? (stageLabel.get(deal.dealstage) ?? deal.dealstage) : '—',
      lineOfBusiness: deal.lineOfBusiness,
    }));

    const wonOn = accountDeals.map((deal) => deal.closed).sort()[0]!;
    const goLiveOn = accountDeals.map((deal) => deal.goLive).sort()[0]!;
    const booked = deals.reduce((sum, deal) => sum.plus(deal.amount), new Decimal(0));

    // Each deal is on its own clock: a second deal won later has billed for less time.
    const expected = accountDeals.reduce((sum, deal) => {
      const months = Math.max(0, (asOf.getTime() - new Date(`${deal.goLive}T00:00:00Z`).getTime()) / DAY_MS / MONTH_DAYS);
      return sum.plus(new Decimal(deal.amount).times(Math.min(1, months / CONTRACT_MONTHS)));
    }, new Decimal(0));

    const invoices = match.customerId
      ? (treeOf.get(match.customerId) ?? []).flatMap((id) => invoicesOf.get(id) ?? [])
      : [];
    const sinceWon = invoices.filter((invoice) => invoice.date >= wonOn);
    const yearBefore = day(new Date(new Date(`${wonOn}T00:00:00Z`).getTime() - 365 * DAY_MS));
    const before = invoices.filter((invoice) => invoice.date < wonOn && invoice.date >= yearBefore);
    const last30 = day(new Date(asOf.getTime() - 30 * DAY_MS));

    const sum = (list: typeof invoices) => list.reduce((total, invoice) => total.plus(invoice.billed), new Decimal(0));
    const billedSinceWon = sum(sinceWon);
    const dates = sinceWon.filter((invoice) => !invoice.billed.isZero()).map((invoice) => invoice.date).sort();

    const monthlyMap = new Map<string, Decimal>();
    for (const invoice of sinceWon) {
      const month = monthOf(invoice.date);
      monthlyMap.set(month, (monthlyMap.get(month) ?? new Decimal(0)).plus(invoice.billed));
    }
    const monthly: AccountBillingRow['monthly'] = [];
    for (let cursor = new Date(`${monthOf(wonOn)}T00:00:00Z`); cursor <= asOf; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
      const month = day(cursor);
      monthly.push({ month, billed: (monthlyMap.get(month) ?? new Decimal(0)).toNumber() });
    }

    const daysLive = (asOf.getTime() - new Date(`${goLiveOn}T00:00:00Z`).getTime()) / DAY_MS;
    const pctOfExpected = expected.gt(0) ? billedSinceWon.div(expected).toNumber() : null;
    const status: BillingStatus = !match.customerId
      ? 'NO_MATCH'
      : billedSinceWon.lte(0)
        ? daysLive > FIRST_INVOICE_GRACE_DAYS
          ? 'NOT_BILLING'
          : 'WAITING'
        : booked.gt(0) && billedSinceWon.gte(booked)
          ? 'REACHED'
          : pctOfExpected === null
            ? 'ON_PACE'
            : pctOfExpected < BEHIND_PACE
              ? 'BEHIND'
              : pctOfExpected > AHEAD_OF_PACE
                ? 'AHEAD'
                : 'ON_PACE';

    rows.push({
      key,
      companyId,
      account: company?.name ?? accountPartOfDealName(deals[0]!.dealName) ?? key,
      owners: [...new Set(accountDeals.map((deal) => deal.owner))],
      deals: accountDeals,
      lineOfBusiness: deals[0]!.lineOfBusiness,
      wonOn,
      goLiveOn,
      booked: booked.toNumber(),
      expectedToDate: expected.toNumber(),
      billedSinceWon: billedSinceWon.toNumber(),
      billedLast30Days: sum(sinceWon.filter((invoice) => invoice.date >= last30)).toNumber(),
      billedBeforeWon: sum(before).toNumber(),
      invoiceCount: sinceWon.reduce((total, invoice) => total + invoice.count, 0),
      firstInvoice: dates[0] ?? null,
      lastInvoice: dates[dates.length - 1] ?? null,
      pctOfExpected,
      pctOfContract: booked.gt(0) ? billedSinceWon.div(booked).toNumber() : null,
      status,
      match,
      monthly,
    });
  }

  rows.sort((a, b) => b.booked - a.booked || a.account.localeCompare(b.account));

  const attention = (row: AccountBillingRow) => row.status === 'NOT_BILLING' || row.status === 'BEHIND';
  const alertsByOwner = new Map<string, AccountBilling['alerts'][number]['rows']>();
  for (const row of rows.filter(attention)) {
    for (const owner of row.owners) {
      alertsByOwner.set(owner, [
        ...(alertsByOwner.get(owner) ?? []),
        {
          key: row.key,
          account: row.account,
          status: row.status,
          detail:
            row.status === 'NOT_BILLING'
              ? `Live since ${row.goLiveOn}, nothing billed yet`
              : `${Math.round((row.pctOfExpected ?? 0) * 100)}% of the amount expected by now has billed`,
        },
      ]);
    }
  }

  return {
    asOf: day(asOf),
    rows,
    totals: {
      accounts: rows.length,
      matched: rows.filter((row) => row.match.customerId).length,
      billing: rows.filter((row) => row.billedSinceWon > 0).length,
      booked: rows.reduce((total, row) => total + row.booked, 0),
      expectedToDate: rows.reduce((total, row) => total + row.expectedToDate, 0),
      billedSinceWon: rows.reduce((total, row) => total + row.billedSinceWon, 0),
      needAttention: rows.filter(attention).length,
    },
    alerts: [...alertsByOwner.entries()]
      .map(([owner, list]) => ({ owner, rows: list }))
      .sort((a, b) => b.rows.length - a.rows.length || a.owner.localeCompare(b.owner)),
    unavailable,
  };
}

/** Top-level QuickBooks customers, for choosing a match by hand. */
export async function listCustomerOptions(db: Database): Promise<CustomerOption[]> {
  const rows = await db
    .select({ id: t.dimQboCustomer.customerId, name: t.dimQboCustomer.displayName, parentId: t.dimQboCustomer.parentId })
    .from(t.dimQboCustomer);
  return rows
    .filter((row) => !row.parentId)
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Records Westport's decision about which QuickBooks customer an account is.
 *
 * `customerId` null is the explicit answer "no QuickBooks customer"; `auto`
 * withdraws the decision and goes back to the suggested match.
 */
export async function decideAccountMatch(
  db: Database,
  userId: string,
  decision: { companyId: string; customerId: string | null | 'auto' },
): Promise<void> {
  if (decision.customerId === 'auto') {
    await db.delete(t.mapCompanyCustomer).where(sql`${t.mapCompanyCustomer.companyId} = ${decision.companyId}`);
    return;
  }
  if (decision.customerId) {
    const [exists] = await db
      .select({ id: t.dimQboCustomer.customerId })
      .from(t.dimQboCustomer)
      .where(sql`${t.dimQboCustomer.customerId} = ${decision.customerId}`)
      .limit(1);
    if (!exists) throw new Error('That QuickBooks customer is not in the customer list — pull QuickBooks customers first.');
  }
  const values = {
    companyId: decision.companyId,
    qboCustomerId: decision.customerId,
    decidedByUserId: userId,
    decidedAt: new Date(),
  };
  await db
    .insert(t.mapCompanyCustomer)
    .values(values)
    .onConflictDoUpdate({ target: t.mapCompanyCustomer.companyId, set: values });
}
