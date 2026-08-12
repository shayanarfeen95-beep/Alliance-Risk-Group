/**
 * Account-level GL -> the five reporting lines.
 *
 * This is where the memo-column relationship is defined, and it is the most
 * dangerous piece of logic in the build. §4.2:
 *
 *   payroll_direct   MEMO ONLY — a component of COGS. Do not subtract separately.
 *   payroll_expense  MEMO ONLY — a component of OpEx. Do not subtract separately.
 *
 * Encoding it structurally — payroll accounts roll up *into* cogs and opex —
 * means the relationship is a property of the data, not an assertion someone has
 * to remember. There is no arrangement of these accounts that produces a
 * double-counted payroll figure.
 *
 * "Getting the memo-column treatment wrong is the most likely way to break this
 * build. It would double-count payroll and understate profit at every division,
 * in every month, on every dashboard."
 */
import Decimal from 'decimal.js';
import { d } from '@/lib/money';

export type ReportingLine = 'revenue' | 'payroll_direct' | 'cogs' | 'payroll_expense' | 'opex';

export interface GlRow {
  accountId: string;
  reportingLine: ReportingLine;
  amount: string | number | Decimal;
}

export interface PlLines {
  revenue: Decimal;
  /** MEMO. Already inside `cogs`. */
  payrollDirect: Decimal;
  /** Inclusive of payrollDirect. */
  cogs: Decimal;
  /** MEMO. Already inside `opex`. */
  payrollExpense: Decimal;
  /** Inclusive of payrollExpense. */
  opex: Decimal;
}

export function rollUpGl(rows: GlRow[]): PlLines {
  let revenue = new Decimal(0);
  let payrollDirect = new Decimal(0);
  let cogsExPayroll = new Decimal(0);
  let payrollExpense = new Decimal(0);
  let opexExPayroll = new Decimal(0);

  for (const row of rows) {
    const amount = d(row.amount);
    switch (row.reportingLine) {
      case 'revenue':
        revenue = revenue.plus(amount);
        break;
      case 'payroll_direct':
        payrollDirect = payrollDirect.plus(amount);
        break;
      case 'cogs':
        cogsExPayroll = cogsExPayroll.plus(amount);
        break;
      case 'payroll_expense':
        payrollExpense = payrollExpense.plus(amount);
        break;
      case 'opex':
        opexExPayroll = opexExPayroll.plus(amount);
        break;
    }
  }

  return {
    revenue,
    payrollDirect,
    // Payroll-direct accounts are COGS accounts. They are surfaced separately as
    // a memo line, not held outside the total.
    cogs: cogsExPayroll.plus(payrollDirect),
    payrollExpense,
    opex: opexExPayroll.plus(payrollExpense),
  };
}

/**
 * The derived measures, §4.2. Computed, never stored.
 *
 *   gross_profit = revenue − cogs     (payroll_direct is NOT subtracted)
 *   net_profit   = gross_profit − opex (payroll_expense is NOT subtracted)
 *
 * If you find yourself wanting to subtract a payroll figure here, re-read §4.2
 * and check SHRC's gross profit against $71,451.
 */
export function grossProfit(lines: Pick<PlLines, 'revenue' | 'cogs'>): Decimal {
  return lines.revenue.minus(lines.cogs);
}

export function netProfit(lines: Pick<PlLines, 'revenue' | 'cogs' | 'opex'>): Decimal {
  return grossProfit(lines).minus(lines.opex);
}
