/**
 * Westport, November 2026: "Month also ends in November, we should have
 * December listed there as well." The rest of the year is offered beside the
 * months that have happened; a view still opens on a month with figures.
 */
import { describe, expect, it } from 'vitest';
import { remainingMonthsOfYear, resolveRange } from '@/lib/dashboards/range';

describe('the month list reaches the end of the year', () => {
  it('offers the months after this one, through December, newest first', () => {
    expect(remainingMonthsOfYear(new Date('2026-11-05T12:00:00Z'))).toEqual(['2026-12-01']);
    expect(remainingMonthsOfYear(new Date('2026-09-30T12:00:00Z'))).toEqual([
      '2026-12-01',
      '2026-11-01',
      '2026-10-01',
    ]);
    expect(remainingMonthsOfYear(new Date('2026-12-15T12:00:00Z'))).toEqual([]);
  });

  it('lets a range run to December once December is offered', () => {
    const months = ['2026-12-01', '2026-11-01', '2026-10-01', '2026-01-01'] as const;
    const range = resolveRange({ from: '2026-01', to: '2026-12' }, '2026-11-01', [...months]);
    expect(range.to).toBe('2026-12-01');
  });
});

describe('one period control: presets and calendar days', () => {
  const months = ['2026-12-01', '2026-11-01', '2026-10-01', '2025-01-01'] as const;
  const today = new Date('2026-11-19T15:00:00Z');
  const at = (params: Parameters<typeof resolveRange>[0]) => resolveRange(params, '2026-10-01', [...months], today);

  it('year to date stops at the last complete month — not November', () => {
    const ytd = at({ range: 'ytd' });
    expect([ytd.fromDay, ytd.toDay]).toEqual(['2026-01-01', '2026-10-31']);
    expect(ytd.to).toBe('2026-10-01');
    // Nothing in the URL is year to date too.
    expect(at({}).toDay).toBe('2026-10-31');
  });

  it('keeps this month and last month as presets', () => {
    expect([at({ range: 'this_month' }).fromDay, at({ range: 'this_month' }).toDay]).toEqual(['2026-11-01', '2026-11-19']);
    expect([at({ range: 'last_month' }).fromDay, at({ range: 'last_month' }).toDay]).toEqual(['2026-10-01', '2026-10-31']);
    expect(at({ range: 'last_year' }).toDay).toBe('2025-12-31');
  });

  it('takes any start and end day, and counts events to the end of the last day', () => {
    const range = at({ from: '2026-09-15', to: '2026-10-03' });
    expect(range.preset).toBe('custom');
    expect(range.wholeMonths).toBe(false);
    expect(range.label).toBe('Sep 15 – Oct 3, 2026');
    expect(range.start.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('still reads an old link that names only a month', () => {
    const range = at({ month: '2026-09' });
    expect([range.fromDay, range.toDay]).toEqual(['2026-01-01', '2026-09-30']);
  });
});
