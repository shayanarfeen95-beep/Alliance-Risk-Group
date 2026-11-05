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
    expect(resolveRange({ range: 'ytd' }, '2026-12-01', [...months]).label).toMatch(/Jan 2026 – Dec 2026/);
  });
});
