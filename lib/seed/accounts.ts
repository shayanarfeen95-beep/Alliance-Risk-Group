/**
 * Chart of accounts.
 *
 * §5.1 recommended upgrade, accepted by Westport: "The Excel model carries only
 * five P&L lines per division per month. That was a constraint of hand entry,
 * not a design choice. Since you are pulling from the QBO API directly, land the
 * full trial balance at account level and roll it up to the five reporting lines
 * through a mapping table."
 *
 * Note which accounts carry `payroll_direct` and `payroll_expense`: they are
 * COGS and OpEx accounts respectively. The memo lines are a *view* of accounts
 * that are already inside their totals — see lib/etl/rollup.ts.
 */
import type { ReportingLine } from '@/lib/etl/rollup';

export interface AccountSeed {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: 'INCOME' | 'COGS' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY';
  reportingLine: ReportingLine | null;
  balanceSheetLine: string | null;
  /** Relative weight when allocating a reporting-line total across accounts. */
  weight?: number;
}

export const REVENUE_ACCOUNTS: AccountSeed[] = [
  { accountId: '4000', accountNumber: '4000', accountName: 'Service Revenue', accountType: 'INCOME', reportingLine: 'revenue', balanceSheetLine: null, weight: 0.62 },
  { accountId: '4010', accountNumber: '4010', accountName: 'Recurring Program Revenue', accountType: 'INCOME', reportingLine: 'revenue', balanceSheetLine: null, weight: 0.21 },
  { accountId: '4020', accountNumber: '4020', accountName: 'Reimbursable / Pass-Through Revenue', accountType: 'INCOME', reportingLine: 'revenue', balanceSheetLine: null, weight: 0.14 },
  { accountId: '4090', accountNumber: '4090', accountName: 'Other Operating Income', accountType: 'INCOME', reportingLine: 'revenue', balanceSheetLine: null, weight: 0.03 },
];

export const COGS_ACCOUNTS: AccountSeed[] = [
  // MEMO line — a component of COGS, never subtracted separately.
  { accountId: '5000', accountNumber: '5000', accountName: 'Direct Labor — Payroll', accountType: 'COGS', reportingLine: 'payroll_direct', balanceSheetLine: null, weight: 1 },
  { accountId: '5010', accountNumber: '5010', accountName: 'Contract Labor — Field Agents', accountType: 'COGS', reportingLine: 'cogs', balanceSheetLine: null, weight: 0.42 },
  { accountId: '5020', accountNumber: '5020', accountName: 'Vendor & Data Costs', accountType: 'COGS', reportingLine: 'cogs', balanceSheetLine: null, weight: 0.31 },
  { accountId: '5030', accountNumber: '5030', accountName: 'Court & Filing Fees', accountType: 'COGS', reportingLine: 'cogs', balanceSheetLine: null, weight: 0.19 },
  { accountId: '5040', accountNumber: '5040', accountName: 'Travel & Mileage — Direct', accountType: 'COGS', reportingLine: 'cogs', balanceSheetLine: null, weight: 0.08 },
];

export const OPEX_ACCOUNTS: AccountSeed[] = [
  // MEMO line — a component of OpEx, never subtracted separately.
  { accountId: '6000', accountNumber: '6000', accountName: 'Salaries & Wages — Administrative', accountType: 'EXPENSE', reportingLine: 'payroll_expense', balanceSheetLine: null, weight: 0.78 },
  { accountId: '6010', accountNumber: '6010', accountName: 'Payroll Taxes & Benefits', accountType: 'EXPENSE', reportingLine: 'payroll_expense', balanceSheetLine: null, weight: 0.22 },
  { accountId: '6100', accountNumber: '6100', accountName: 'Rent & Occupancy', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.18 },
  { accountId: '6110', accountNumber: '6110', accountName: 'Software & Subscriptions', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.14 },
  { accountId: '6120', accountNumber: '6120', accountName: 'Insurance', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.09 },
  { accountId: '6130', accountNumber: '6130', accountName: 'Professional Fees', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.11 },
  { accountId: '6140', accountNumber: '6140', accountName: 'Marketing & Advertising', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.12 },
  { accountId: '6145', accountNumber: '6145', accountName: 'Digital Advertising', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.08 },
  { accountId: '6150', accountNumber: '6150', accountName: 'Sales Commissions', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.1 },
  { accountId: '6160', accountNumber: '6160', accountName: 'Telephone & Internet', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.05 },
  { accountId: '6170', accountNumber: '6170', accountName: 'Office & Supplies', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.05 },
  { accountId: '6180', accountNumber: '6180', accountName: 'Bank & Merchant Fees', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.04 },
  { accountId: '6190', accountNumber: '6190', accountName: 'Depreciation & Amortization', accountType: 'EXPENSE', reportingLine: 'opex', balanceSheetLine: null, weight: 0.04 },
];

export const BALANCE_SHEET_ACCOUNTS: AccountSeed[] = [
  { accountId: '1000', accountNumber: '1000', accountName: 'Operating Cash', accountType: 'ASSET', reportingLine: null, balanceSheetLine: 'cash' },
  { accountId: '1100', accountNumber: '1100', accountName: 'Accounts Receivable', accountType: 'ASSET', reportingLine: null, balanceSheetLine: 'accounts_receivable' },
  { accountId: '1200', accountNumber: '1200', accountName: 'Prepaid Expenses & Deposits', accountType: 'ASSET', reportingLine: null, balanceSheetLine: 'other_current_assets' },
  { accountId: '1500', accountNumber: '1500', accountName: 'Property & Equipment, net', accountType: 'ASSET', reportingLine: null, balanceSheetLine: 'fixed_assets' },
  { accountId: '2000', accountNumber: '2000', accountName: 'Accounts Payable', accountType: 'LIABILITY', reportingLine: null, balanceSheetLine: 'accounts_payable' },
  { accountId: '2100', accountNumber: '2100', accountName: 'Credit Cards Payable', accountType: 'LIABILITY', reportingLine: null, balanceSheetLine: 'cc_liability' },
  { accountId: '2200', accountNumber: '2200', accountName: 'Accrued Liabilities', accountType: 'LIABILITY', reportingLine: null, balanceSheetLine: 'other_current_liabilities' },
  { accountId: '2500', accountNumber: '2500', accountName: 'Notes Payable — Long Term', accountType: 'LIABILITY', reportingLine: null, balanceSheetLine: 'lt_liabilities' },
  // Defect 3: loaded from QBO as its own figure, never plugged as assets minus
  // liabilities. That is what makes the balance check a real assertion.
  { accountId: '3000', accountNumber: '3000', accountName: "Shareholders' Equity", accountType: 'EQUITY', reportingLine: null, balanceSheetLine: 'shareholder_equity' },
];

export const ALL_ACCOUNTS: AccountSeed[] = [
  ...REVENUE_ACCOUNTS,
  ...COGS_ACCOUNTS,
  ...OPEX_ACCOUNTS,
  ...BALANCE_SHEET_ACCOUNTS,
];

/**
 * §6 Marketing: "Marketing spend must resolve to a specific, agreed set of QBO
 * accounts — and CAC's numerator (sales and marketing) is a different set from
 * CPL's and ROAS's (marketing only). Get both account lists signed off by
 * Westport before you publish any of these four."
 *
 * Two distinct sets, deliberately. Sales commissions belong to CAC's numerator
 * and to neither CPL's nor ROAS's.
 */
export const MARKETING_SPEND_ACCOUNTS = ['6140', '6145'];
export const SALES_AND_MARKETING_SPEND_ACCOUNTS = ['6140', '6145', '6150'];
