import 'server-only';
import Decimal from 'decimal.js';
import { lte } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SemanticSession } from '@/lib/semantic/resolve';
import type { MonthKey } from '@/lib/semantic/periods';

/**
 * Revenue from existing customers against net-new ones, by business line.
 *
 * Westport, November 2026, finalising the 2027 budget: "we are trying to
 * determine how much revenue will come from existing clients vs. net new … by
 * business line to track net new vs. existing client growth." And: "we have
 * some great existing client growth that should be categorized separately from
 * net new across each business line."
 *
 * The rule, stated on every surface that shows it:
 *   - A customer is EXISTING in a business line when QuickBooks shows it
 *     earning income in that line in any loaded month before the period starts.
 *   - Otherwise its revenue in that line is NET NEW.
 *   - At ARG Total, existing means it earned in any line before the period: a
 *     customer new to one line but not to ARG is cross-sell, counted as existing.
 *   - Existing customers' growth is the period against the same months a year
 *     earlier.
 * Jobs (sub-customers) count as their parent. Accrual basis, from QuickBooks'
 * Income by Customer report, which ties to the P&L's income.
 */

export interface MixLine {
  key: string;
  label: string;
  /** The QuickBooks class names that make it up. */
  classes: string[];
  total: number;
  existing: number;
  netNew: number;
  existingCustomers: number;
  newCustomers: number;
  /** The same customers' revenue in the same months a year earlier. */
  existingPriorYear: number;
  /** existing − existingPriorYear. */
  existingGrowth: number;
}

export interface MixCustomer {
  customerId: string;
  name: string;
  line: string;
  revenue: number;
  priorYear: number;
  kind: 'existing' | 'new';
  firstMonth: string;
}

export interface RevenueMix {
  months: MonthKey[];
  /** The first month any customer revenue is loaded for. */
  historyFrom: string | null;
  /** Months of history before the period: how far back "existing" can see. */
  monthsOfHistory: number;
  lines: MixLine[];
  total: MixLine;
  byMonth: Array<{ month: string; existing: number; netNew: number }>;
  topNew: MixCustomer[];
  topGrowth: MixCustomer[];
  topDecline: MixCustomer[];
  unavailable: string | null;
}

const shiftYear = (month: string, years: number) => `${Number(month.slice(0, 4)) + years}${month.slice(4)}`;

export async function loadRevenueMix(
  db: Database,
  session: SemanticSession,
  options: { months: MonthKey[]; divisionCode?: string | null },
): Promise<RevenueMix> {
  const months = [...options.months].sort();
  const empty: RevenueMix = {
    months,
    historyFrom: null,
    monthsOfHistory: 0,
    lines: [],
    total: blank('ARG_TOTAL', 'ARG Total'),
    byMonth: [],
    topNew: [],
    topGrowth: [],
    topDecline: [],
    unavailable: null,
  };
  if (!months.length) return { ...empty, unavailable: 'No months in the period.' };
  const last = months[months.length - 1]!;
  const first = months[0]!;

  const [rows, customers] = await Promise.all([
    db
      .select({
        month: t.factCustomerRevenue.periodMonth,
        classKey: t.factCustomerRevenue.classKey,
        className: t.factCustomerRevenue.className,
        divisionCode: t.factCustomerRevenue.divisionCode,
        customerId: t.factCustomerRevenue.customerId,
        customerName: t.factCustomerRevenue.customerName,
        income: t.factCustomerRevenue.income,
      })
      .from(t.factCustomerRevenue)
      .where(lte(t.factCustomerRevenue.periodMonth, last)),
    db
      .select({ id: t.dimQboCustomer.customerId, name: t.dimQboCustomer.displayName, parentId: t.dimQboCustomer.parentId })
      .from(t.dimQboCustomer),
  ]);

  if (rows.length === 0) {
    return {
      ...empty,
      unavailable:
        'Revenue by customer has not been loaded from QuickBooks yet. Pull QuickBooks — the “Revenue by customer and business line” step — in Admin → Data & pulls.',
    };
  }

  // Jobs count as their parent.
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const topOf = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (byId.get(current)?.parentId && !seen.has(current)) {
      seen.add(current);
      current = byId.get(current)!.parentId!;
    }
    return current;
  };
  const nameOf = (id: string, fallback: string | null) => byId.get(id)?.name ?? fallback ?? id;

  const divisionName = new Map(session.bundle.divisions.map((d) => [d.divisionCode, d.divisionName]));
  const lineOf = (row: (typeof rows)[number]): string =>
    row.divisionCode && row.divisionCode !== 'EXCLUDED' ? row.divisionCode : 'OTHER';

  // revenue[line][customer][month]
  const revenue = new Map<string, Map<string, Map<string, Decimal>>>();
  const classesOf = new Map<string, Set<string>>();
  const allByCustomerMonth = new Map<string, Decimal>(); // ALL report, for the unclassed remainder
  const classedByCustomerMonth = new Map<string, Decimal>();
  const names = new Map<string, string>();
  let historyFrom: string | null = null;

  const add = (line: string, customer: string, month: string, value: Decimal) => {
    const lineMap = revenue.get(line) ?? new Map<string, Map<string, Decimal>>();
    const customerMap = lineMap.get(customer) ?? new Map<string, Decimal>();
    customerMap.set(month, (customerMap.get(month) ?? new Decimal(0)).plus(value));
    lineMap.set(customer, customerMap);
    revenue.set(line, lineMap);
  };

  for (const row of rows) {
    const month = String(row.month).slice(0, 10);
    if (!historyFrom || month < historyFrom) historyFrom = month;
    const customer = row.customerId.startsWith('name:') ? row.customerId : topOf(row.customerId);
    names.set(customer, nameOf(customer, row.customerName));
    const value = new Decimal(row.income);
    const key = `${customer}|${month}`;
    if (row.classKey === 'ALL') {
      allByCustomerMonth.set(key, (allByCustomerMonth.get(key) ?? new Decimal(0)).plus(value));
      continue;
    }
    classedByCustomerMonth.set(key, (classedByCustomerMonth.get(key) ?? new Decimal(0)).plus(value));
    const line = lineOf(row);
    add(line, customer, month, value);
    const set = classesOf.get(line) ?? new Set<string>();
    if (row.className) set.add(row.className);
    classesOf.set(line, set);
  }
  // Revenue on no class: the company report less every class.
  for (const [key, total] of allByCustomerMonth) {
    const rest = total.minus(classedByCustomerMonth.get(key) ?? 0);
    if (rest.abs().lt(0.5)) continue;
    const [customer, month] = key.split('|') as [string, string];
    add('NO_CLASS', customer, month, rest);
  }

  const inPeriod = new Set(months);
  const priorYearMonths = new Set(months.map((month) => shiftYear(month, -1)));
  const sumWhere = (series: Map<string, Decimal> | undefined, test: (month: string) => boolean) => {
    let total = new Decimal(0);
    for (const [month, value] of series ?? []) if (test(month)) total = total.plus(value);
    return total;
  };
  const earnedBefore = (series: Map<string, Decimal> | undefined) =>
    sumWhere(series, (month) => month < first).gt(0.5);

  const customersOverall = new Map<string, Map<string, Decimal>>();
  for (const lineMap of revenue.values()) {
    for (const [customer, series] of lineMap) {
      const merged = customersOverall.get(customer) ?? new Map<string, Decimal>();
      for (const [month, value] of series) merged.set(month, (merged.get(month) ?? new Decimal(0)).plus(value));
      customersOverall.set(customer, merged);
    }
  }

  const customerRows: MixCustomer[] = [];
  const summarise = (key: string, label: string, lineMap: Map<string, Map<string, Decimal>>, record: boolean): MixLine => {
    const line = blank(key, label);
    line.classes = [...(classesOf.get(key) ?? [])].sort();
    for (const [customer, series] of lineMap) {
      const value = sumWhere(series, (month) => inPeriod.has(month)).toNumber();
      if (Math.abs(value) < 0.5) continue;
      const priorYear = sumWhere(series, (month) => priorYearMonths.has(month)).toNumber();
      const existing = earnedBefore(series);
      line.total += value;
      if (existing) {
        line.existing += value;
        line.existingCustomers += 1;
        line.existingPriorYear += priorYear;
      } else {
        line.netNew += value;
        line.newCustomers += 1;
      }
      if (record) {
        const firstMonth = [...series.entries()].filter(([, v]) => v.gt(0)).map(([m]) => m).sort()[0] ?? first;
        customerRows.push({
          customerId: customer,
          name: names.get(customer) ?? customer,
          line: label,
          revenue: value,
          priorYear,
          kind: existing ? 'existing' : 'new',
          firstMonth: firstMonth.slice(0, 7),
        });
      }
    }
    line.existingGrowth = line.existing - line.existingPriorYear;
    return line;
  };

  const labelFor = (key: string) =>
    key === 'OTHER'
      ? 'Other classes (Z Alloc, Not Specified…)'
      : key === 'NO_CLASS'
        ? 'No class in QuickBooks'
        : (divisionName.get(key) ?? key);
  const order = [...session.bundle.divisions.map((d) => d.divisionCode), 'OTHER', 'NO_CLASS'];
  const wantDivision = options.divisionCode && options.divisionCode !== 'ARG_TOTAL' ? options.divisionCode : null;
  const lines = order
    .filter((key) => revenue.has(key))
    .filter((key) => !wantDivision || key === wantDivision)
    .map((key) => summarise(key, labelFor(key), revenue.get(key)!, true))
    .filter((line) => Math.abs(line.total) >= 0.5);

  const total = wantDivision
    ? { ...(lines[0] ?? blank(wantDivision, labelFor(wantDivision))) }
    : summarise('ARG_TOTAL', 'ARG Total', customersOverall, false);

  // Month by month, at the level shown.
  const scopeMap = wantDivision ? (revenue.get(wantDivision) ?? new Map()) : customersOverall;
  const byMonth = months.map((month) => {
    let existing = 0;
    let netNew = 0;
    for (const series of scopeMap.values()) {
      const value = series.get(month)?.toNumber() ?? 0;
      if (Math.abs(value) < 0.005) continue;
      if (earnedBefore(series)) existing += value;
      else netNew += value;
    }
    return { month, existing, netNew };
  });

  const monthsOfHistory = historyFrom
    ? Math.max(0, (Number(first.slice(0, 4)) - Number(historyFrom.slice(0, 4))) * 12 + Number(first.slice(5, 7)) - Number(historyFrom.slice(5, 7)))
    : 0;

  return {
    months,
    historyFrom,
    monthsOfHistory,
    lines,
    total,
    byMonth,
    topNew: customerRows.filter((row) => row.kind === 'new').sort((a, b) => b.revenue - a.revenue).slice(0, 15),
    topGrowth: customerRows
      .filter((row) => row.kind === 'existing' && row.revenue - row.priorYear > 0)
      .sort((a, b) => b.revenue - b.priorYear - (a.revenue - a.priorYear))
      .slice(0, 15),
    topDecline: customerRows
      .filter((row) => row.kind === 'existing' && row.revenue - row.priorYear < 0)
      .sort((a, b) => a.revenue - a.priorYear - (b.revenue - b.priorYear))
      .slice(0, 10),
    unavailable: null,
  };
}

function blank(key: string, label: string): MixLine {
  return {
    key,
    label,
    classes: [],
    total: 0,
    existing: 0,
    netNew: 0,
    existingCustomers: 0,
    newCustomers: 0,
    existingPriorYear: 0,
    existingGrowth: 0,
  };
}
