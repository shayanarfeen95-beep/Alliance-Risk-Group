/**
 * Finding the right tab in ARG's spreadsheet.
 *
 * All three Sheets entities imported nothing for months and said only "that
 * range came back empty". The cause was not the parsing and not the credential:
 * the tab names were hardcoded as "Monthly Budget", "10X Budget" and
 * "Headcount", and Google answers a range naming a tab that does not exist with
 * an empty result rather than an error. Nothing distinguished "the budget is
 * empty" from "there is no tab by that name".
 *
 * So the tab is matched against the names the spreadsheet actually has. These
 * tests are mostly about the ways that matching could go wrong quietly — a 10X
 * plan loaded as the operating budget would put the wrong target on every
 * variance chart, which is worse than importing nothing.
 */
import { describe, expect, it } from 'vitest';
import { matchTab } from '@/lib/connectors/sheets';

describe('matching a spreadsheet tab to an entity', () => {
  it('finds the obvious names', () => {
    const tabs = ['Monthly Budget', '10X Budget', 'Headcount'];

    expect(matchTab('monthly_budget', tabs)).toBe('Monthly Budget');
    expect(matchTab('tenx_budget', tabs)).toBe('10X Budget');
    expect(matchTab('headcount', tabs)).toBe('Headcount');
  });

  it('copes with the names a real spreadsheet actually uses', () => {
    const tabs = ['Summary', 'FY26 Budget', '10x Growth Plan', 'FTE by month', 'Notes'];

    expect(matchTab('monthly_budget', tabs)).toBe('FY26 Budget');
    expect(matchTab('tenx_budget', tabs)).toBe('10x Growth Plan');
    expect(matchTab('headcount', tabs)).toBe('FTE by month');
  });

  it('never loads the 10X plan as the operating budget', () => {
    // Both tabs contain "Budget". Taking the 10X one as the monthly budget puts
    // a growth target where the operating plan should be, and every variance
    // reads as a catastrophic miss — a wrong number, not a missing one.
    const tabs = ['10X Budget', 'Monthly Budget'];

    expect(matchTab('monthly_budget', tabs)).toBe('Monthly Budget');
    expect(matchTab('tenx_budget', tabs)).toBe('10X Budget');
  });

  it('will not hand the same tab to two entities', () => {
    const tabs = ['10X Budget'];

    expect(matchTab('tenx_budget', tabs)).toBe('10X Budget');
    // There is no operating budget in this spreadsheet. Saying so beats
    // silently reporting against the growth plan.
    expect(matchTab('monthly_budget', tabs)).toBeNull();
  });

  it('ignores case and stray spacing', () => {
    expect(matchTab('headcount', ['  HEAD COUNT  '])).toBe('  HEAD COUNT  ');
    expect(matchTab('monthly_budget', ['monthly budget'])).toBe('monthly budget');
  });

  it('returns null rather than guessing when nothing matches', () => {
    const tabs = ['Sheet1', 'Raw export', 'Pivot'];

    expect(matchTab('monthly_budget', tabs)).toBeNull();
    expect(matchTab('tenx_budget', tabs)).toBeNull();
    expect(matchTab('headcount', tabs)).toBeNull();
  });

  it('does not match a word merely containing the pattern', () => {
    // "Budgeting notes" is prose, not the budget. This is a soft case and the
    // match is deliberately permissive, but "10xyz" must not read as 10X.
    expect(matchTab('tenx_budget', ['10xyz analysis'])).toBeNull();
  });
});
