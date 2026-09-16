/**
 * The query parameters each QuickBooks report actually accepts.
 *
 * Every monthly report was being sent the same set — `start_date`, `end_date`,
 * `accounting_method` and `summarize_column_by=Classes` — on the assumption that
 * QuickBooks would use what applied and ignore the rest. It does not. An
 * unsupported parameter comes back as a 400, so:
 *
 *   balance_sheet   FAILED outright on a company that does not class it
 *   trial_balance   has no class dimension at all
 *   ar_aging        is as-at a date, under `report_date`, not a range
 *   ap_aging        the same
 *
 * which is precisely the pattern in ARG's load history: one FAILED row and
 * several that succeeded having written nothing. These assertions pin the shape
 * per report so a future entity cannot quietly inherit the wrong one.
 */
import { describe, expect, it } from 'vitest';
import { REPORT_SPECS, reportParams } from '@/lib/connectors/qbo';

describe('QuickBooks report parameters', () => {
  it('asks the profit and loss to summarise by class, over a month range', () => {
    const params = reportParams(REPORT_SPECS.profit_and_loss!, '2026-04-01', true);

    expect(params.start_date).toBe('2026-04-01');
    expect(params.end_date).toBe('2026-04-30');
    expect(params.summarize_column_by).toBe('Classes');
    // Rule 3: ARG reports on the accrual basis, always stated, never mixed.
    expect(params.accounting_method).toBe('Accrual');
  });

  it('never asks the trial balance to summarise by class', () => {
    const params = reportParams(REPORT_SPECS.trial_balance!, '2026-04-01', true);

    // Asking anyway is a 400, and a 400 here is a whole entity that never loads.
    expect(params.summarize_column_by).toBeUndefined();
    expect(params.accounting_method).toBe('Accrual');
  });

  it('asks the aging reports as at a date, not over a range', () => {
    for (const entity of ['ar_aging', 'ap_aging'] as const) {
      const params = reportParams(REPORT_SPECS[entity]!, '2026-04-01', true);

      expect(params.report_date).toBe('2026-04-30');
      expect(params.start_date).toBeUndefined();
      expect(params.end_date).toBeUndefined();
      // Aging is a position on the ledger; a basis does not apply to it.
      expect(params.accounting_method).toBeUndefined();
    }
  });

  it('asks the aging reports for the class column, since the division depends on it', () => {
    // The summary aging report carries no class at all. Without this column the
    // detail report is no better, and fact_aging stays empty.
    expect(REPORT_SPECS.ar_aging!.report).toBe('AgedReceivableDetail');
    expect(REPORT_SPECS.ap_aging!.report).toBe('AgedPayableDetail');
    expect(reportParams(REPORT_SPECS.ar_aging!, '2026-04-01', true).columns).toContain('klass_name');
    expect(reportParams(REPORT_SPECS.ap_aging!, '2026-04-01', true).columns).toContain('klass_name');
  });

  it('drops the class breakdown on the retry, so an unclassed report still loads', () => {
    // Open item 1: a company that does not class its balance sheet gets ARG
    // Total figures and a conform note, rather than an entity that never loads.
    const classed = reportParams(REPORT_SPECS.balance_sheet!, '2026-04-01', true);
    const unclassed = reportParams(REPORT_SPECS.balance_sheet!, '2026-04-01', false);

    expect(classed.summarize_column_by).toBe('Classes');
    expect(unclassed.summarize_column_by).toBeUndefined();
    expect(unclassed.end_date).toBe('2026-04-30');
  });

  it('ends every month on its real last day, including February', () => {
    expect(reportParams(REPORT_SPECS.profit_and_loss!, '2026-02-01', true).end_date).toBe('2026-02-28');
    expect(reportParams(REPORT_SPECS.profit_and_loss!, '2024-02-01', true).end_date).toBe('2024-02-29');
  });
});
