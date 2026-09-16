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

  it('does not route the aging through a report at all', () => {
    // No QuickBooks aging report carries a class: Intuit's documented column
    // list for the DETAIL report has no klass_name, and the SUMMARY report is
    // grouped by customer or vendor. fact_aging is keyed on division, so an
    // aging report can never fill it — which is what twelve identical "came
    // back without a class column" notes and a row count of zero were saying.
    //
    // Aging is built from open Invoice and Bill records instead, which do carry
    // ClassRef. Keeping these out of the report table is what stops anybody
    // reintroducing an aging report and wondering why the division is empty.
    expect(REPORT_SPECS.ar_aging).toBeUndefined();
    expect(REPORT_SPECS.ap_aging).toBeUndefined();
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
