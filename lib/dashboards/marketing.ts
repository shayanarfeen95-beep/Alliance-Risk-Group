import 'server-only';
import Decimal from 'decimal.js';
import { safeDiv } from '@/lib/money';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds, formatMonthShort } from '@/lib/semantic/periods';
import { sumSpend } from '@/lib/semantic/facts';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import { buildKpiTiles } from './tiles';
import { boxState, type BoxScopeResolver } from './context';
import type { BoxFilterState } from './box-filter';

/**
 * §9.4 — Marketing dashboard, HubSpot + QuickBooks.
 *
 * The four spend-dependent KPIs are gated on Westport signing off the account
 * sets (§6). When they are not confirmed the tiles say so rather than computing
 * on an unagreed denominator, because "an unagreed denominator makes all of them
 * unusable."
 */

const MARKETING_TILES: Array<{ id: string; hint: string }> = [
  { id: 'leads_received', hint: 'COUNT(contacts) by the date they became a lead' },
  { id: 'cost_per_lead', hint: 'Marketing spend ÷ lead count. Marketing-only account set.' },
  {
    id: 'customer_acquisition_cost',
    hint: 'Sales AND marketing spend ÷ new customers won — a deliberately different, larger account set than CPL uses.',
  },
  { id: 'roas', hint: 'Revenue from attributed closed-won deals ÷ ad spend' },
  { id: 'marketing_efficiency_ratio', hint: 'Total revenue ÷ total marketing spend' },
];

const SOURCE_LABELS: Record<string, string> = {
  ORGANIC_SEARCH: 'Organic search',
  PAID_SEARCH: 'Paid search',
  REFERRALS: 'Referrals',
  DIRECT_TRAFFIC: 'Direct traffic',
  EMAIL_MARKETING: 'Email marketing',
  SOCIAL_MEDIA: 'Social media',
  OFFLINE: 'Offline sources',
};

export interface LeadSourceRow {
  source: string;
  label: string;
  leads: number;
  costPerLead: number | null;
  customers: number;
  conversionRate: number | null;
}

export interface MarketingViewModel {
  tiles: KpiTileProps[];
  boxes: {
    spendTrend: BoxFilterState;
    leadsTrend: BoxFilterState;
    sources: BoxFilterState;
    conversion: BoxFilterState;
  };
  sources: LeadSourceRow[];
  spendTrend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  spendTrendSeries: Array<{ id: string; label: string; color: string }>;
  leadsTrend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  leadsTrendSeries: Array<{ id: string; label: string; color: string }>;
  conversion: { leadToCustomer: number | null; averageDaysLeadToClose: number | null };
  spendPending?: string;
}

const num = (result: { value: Decimal | null }): number | null =>
  result.value ? result.value.toNumber() : null;

export function loadMarketing(
  session: SemanticSession,
  divisionCode: string,
  boxScope: BoxScopeResolver,
): MarketingViewModel {

  const tiles = buildKpiTiles(boxScope, MARKETING_TILES, 'marketing');

  const spendTrendScope = boxScope('marketing_spend_trend');
  const leadsTrendScope = boxScope('marketing_leads_trend');
  const sourcesScope = boxScope('marketing_sources');
  const conversionScope = boxScope('marketing_conversion');

  /** The divisions one box sums over. */
  const divisionsFor = (scope: { divisionCode: string; session: SemanticSession }) =>
    scope.divisionCode === CONSOLIDATED_CODE ? scope.session.visibleDivisions : [scope.divisionCode];

  const spendPending = resolveKpi(session, 'cost_per_lead', divisionCode).unavailable;

  /** Whether a contact belongs to one box's division. */
  const inBoxScope = (boxDivision: string) => (code: string | null) =>
    boxDivision === CONSOLIDATED_CODE || (code !== null && code === boxDivision);

  // --- Leads by original source, with each source's cost per lead --------
  const sourcesInScope = inBoxScope(sourcesScope.divisionCode);
  const { start, endExclusive } = monthBounds(sourcesScope.month);
  const leadsThisMonth = sourcesScope.session.bundle.contacts.filter(
    (contact) =>
      contact.becameLeadDate !== null &&
      contact.becameLeadDate >= start &&
      contact.becameLeadDate < endExclusive &&
      sourcesInScope(contact.divisionCode),
  );

  const totalSpend = sumSpend(
    sourcesScope.session.bundle.marketingSpend,
    [sourcesScope.month],
    divisionsFor(sourcesScope),
  );

  const bySource = new Map<string, { leads: number; customers: number }>();
  for (const contact of leadsThisMonth) {
    const source = contact.originalSource ?? 'UNKNOWN';
    const entry = bySource.get(source) ?? { leads: 0, customers: 0 };
    entry.leads += 1;
    if (contact.becameCustomerDate) entry.customers += 1;
    bySource.set(source, entry);
  }

  const totalLeads = leadsThisMonth.length;

  const sources: LeadSourceRow[] = [...bySource.entries()]
    .map(([source, entry]) => ({
      source,
      label: SOURCE_LABELS[source] ?? source,
      leads: entry.leads,
      // Spend is apportioned across sources by lead share. Stated plainly on the
      // dashboard, because HubSpot carries no per-source spend.
      costPerLead:
        spendPending || totalLeads === 0
          ? null
          : safeDiv(totalSpend.times(entry.leads / totalLeads), entry.leads).toNumber(),
      customers: entry.customers,
      conversionRate: entry.leads === 0 ? null : entry.customers / entry.leads,
    }))
    .sort((a, b) => b.leads - a.leads);

  // --- Trailing twelve months: spend against leads and closed-won revenue -
  const spendTrendSeries = [
    { id: 'spend', label: 'Marketing spend', color: 'var(--series-2)' },
    { id: 'closedWon', label: 'Closed-won revenue', color: 'var(--series-1)' },
  ];

  const spendTrend = spendTrendScope.session.period.trailingTwelveMonths.map((month) => ({
    x: month,
    xLabel: formatMonthShort(month),
    spend: spendPending
      ? null
      : sumSpend(
          spendTrendScope.session.bundle.marketingSpend,
          [month],
          divisionsFor(spendTrendScope),
        ).toNumber(),
    closedWon: num(
      resolveKpi(spendTrendScope.session, 'dollars_booked', spendTrendScope.divisionCode, { month }),
    ),
  }));

  const leadsTrendSeries = [{ id: 'leads', label: 'Leads received', color: 'var(--series-3)' }];
  const leadsTrend = leadsTrendScope.session.period.trailingTwelveMonths.map((month) => ({
    x: month,
    xLabel: formatMonthShort(month),
    leads: num(
      resolveKpi(leadsTrendScope.session, 'leads_received', leadsTrendScope.divisionCode, { month }),
    ),
  }));

  // --- Lead-to-customer conversion and average days lead to close --------
  const conversionInScope = inBoxScope(conversionScope.divisionCode);
  const conversionBounds = monthBounds(conversionScope.month);
  const conversionLeads = conversionScope.session.bundle.contacts.filter(
    (contact) =>
      contact.becameLeadDate !== null &&
      contact.becameLeadDate >= conversionBounds.start &&
      contact.becameLeadDate < conversionBounds.endExclusive &&
      conversionInScope(contact.divisionCode),
  );
  const customersThisMonth = conversionScope.session.bundle.contacts.filter(
    (contact) =>
      contact.becameCustomerDate !== null &&
      contact.becameCustomerDate >= conversionBounds.start &&
      contact.becameCustomerDate < conversionBounds.endExclusive &&
      conversionInScope(contact.divisionCode),
  );

  const daysLeadToClose = customersThisMonth
    .filter((contact) => contact.becameLeadDate !== null)
    .map(
      (contact) =>
        (contact.becameCustomerDate!.getTime() - contact.becameLeadDate!.getTime()) / 86_400_000,
    );

  return {
    tiles,
    boxes: {
      spendTrend: boxState(spendTrendScope),
      leadsTrend: boxState(leadsTrendScope),
      sources: boxState(sourcesScope),
      conversion: boxState(conversionScope),
    },
    sources,
    spendTrend,
    spendTrendSeries,
    leadsTrend,
    leadsTrendSeries,
    conversion: {
      leadToCustomer:
        conversionLeads.length === 0 ? null : customersThisMonth.length / conversionLeads.length,
      averageDaysLeadToClose:
        daysLeadToClose.length === 0
          ? null
          : daysLeadToClose.reduce((sum, days) => sum + days, 0) / daysLeadToClose.length,
    },
    spendPending: spendPending?.detail,
  };
}
