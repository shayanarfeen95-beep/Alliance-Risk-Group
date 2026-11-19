/**
 * How far back a pull reaches, and what the range actually constrains.
 *
 * Two faults, one label. The screen printed "2026-01 → 2026-03" over every
 * pull, and it was wrong in opposite directions for the two sources.
 *
 * For HubSpot it claimed a filter that does not exist. HubSpot is fetched by
 * object and narrowed on modification time; the window is carried into the
 * returned batch and never used to build a request. The pull imports the whole
 * portal. Printing a month range over it describes a limit that was never
 * applied — and invites the reasonable question "why only three months?" about
 * an import that was never limited to three.
 *
 * For QuickBooks it was a real limit, ending at DEFAULT_REPORTING_MONTH — a
 * DISPLAY setting, set once and rarely moved. With it sitting at its seeded
 * 2026-03, a pull run in September fetched January to March and stopped. Six
 * months of books had never been fetched and never would be, however many times
 * anybody pressed Pull, and the window on screen read as a description of the
 * data rather than as a cap on it.
 */
import { describe, expect, it } from 'vitest';
import { monthsInWindow } from '@/lib/connectors/types';

/** The window arithmetic the sync route performs. */
function shiftMonths(month: string, delta: number): string {
  const [year, monthOfYear] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthOfYear - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function planWindow(options: { today: string; configured?: string; months?: number }) {
  const thisMonth = options.today;
  const windowEnd =
    options.configured && options.configured > thisMonth ? options.configured : thisMonth;
  const months = Math.min(Math.max(options.months ?? 12, 1), 36);
  return { windowStart: shiftMonths(windowEnd, -(months - 1)), windowEnd };
}

describe('the sync window', () => {
  it('reaches the current month, not the month the dashboards happen to show', () => {
    // The exact case that lost six months: reporting month seeded at 2026-03,
    // pull run in September.
    const { windowStart, windowEnd } = planWindow({
      today: '2026-09-01',
      configured: '2026-03-01',
    });

    expect(windowEnd).toBe('2026-09-01');
    expect(monthsInWindow({ start: windowStart, end: windowEnd })).toContain('2026-06-01');
    expect(monthsInWindow({ start: windowStart, end: windowEnd })).toContain('2026-09-01');
  });

  it('still honours a reporting month set ahead of the calendar', () => {
    // A deployment reporting on a month ahead of today must still fetch it.
    const { windowEnd } = planWindow({ today: '2026-09-01', configured: '2026-11-01' });
    expect(windowEnd).toBe('2026-11-01');
  });

  it('covers a year, so a trailing-twelve chart can be filled', () => {
    const { windowStart, windowEnd } = planWindow({ today: '2026-09-01' });

    // Three months could not fill a single trailing-twelve view, which is what
    // most of the finance dashboard is built from.
    expect(monthsInWindow({ start: windowStart, end: windowEnd })).toHaveLength(12);
    expect(windowStart).toBe('2025-10-01');
  });

  it('never reaches further back than asked', () => {
    const { windowStart } = planWindow({ today: '2026-09-01', months: 3 });
    expect(windowStart).toBe('2026-07-01');
  });
});

describe('what the window constrains', () => {
  it('is a real limit for QuickBooks, which is fetched a month at a time', () => {
    const months = monthsInWindow({ start: '2026-07-01', end: '2026-09-01' });

    // One report call per month — so a month outside the window is genuinely
    // never requested.
    expect(months).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
  });

  it('is not a limit for HubSpot, which never builds a request from it', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/connectors/hubspot.ts', 'utf8'),
    );

    // The window reaches the connector and is only ever copied into the batch it
    // returns. If a future change starts filtering on it, this assertion should
    // fail and the label on screen should change with it — the two must not
    // drift apart again.
    const uses = source
      .split('\n')
      .filter((line) => /\bwindow\b/.test(line))
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .map((line) => line.trim());

    for (const line of uses) {
      expect(
        line === 'window,' ||
          line.includes('window: FetchWindow') ||
          line.includes('FetchWindow'),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// An explicit range, for everything the trailing window cannot express
// ---------------------------------------------------------------------------

/** The resolution the plan step performs when a range is supplied. */
function resolveRange(options: {
  today: string;
  months?: number;
  windowStart?: string;
  windowEnd?: string;
}): { windowStart: string; windowEnd: string } | { error: string } {
  const asMonth = (value: string | undefined): string | null => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})/.exec(value.trim());
    if (!match) return null;
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return `${match[1]}-${match[2]}-01`;
  };

  const span = (start: string, end: string) => {
    const [sy, sm] = start.split('-').map(Number) as [number, number];
    const [ey, em] = end.split('-').map(Number) as [number, number];
    return (ey - sy) * 12 + (em - sm) + 1;
  };

  const windowEnd = options.today;
  const months = Math.min(Math.max(options.months ?? 12, 1), 36);
  let start = shiftMonths(windowEnd, -(months - 1));
  let end = windowEnd;

  const explicitStart = asMonth(options.windowStart);
  const explicitEnd = asMonth(options.windowEnd);

  if (explicitStart || explicitEnd) {
    start = explicitStart ?? explicitEnd!;
    end = explicitEnd ?? explicitStart!;
    if (start > end) [start, end] = [end, start];
    if (span(start, end) > 36) return { error: `${span(start, end)} months` };
  }

  return { windowStart: start, windowEnd: end };
}

describe('an explicit import range', () => {
  it('pulls a named calendar year end to end', () => {
    // Loading 2024 to compare against 2025 is a normal request and the trailing
    // window has no way to express it.
    expect(resolveRange({ today: '2026-09-01', windowStart: '2024-01', windowEnd: '2024-12' })).toEqual({
      windowStart: '2024-01-01',
      windowEnd: '2024-12-01',
    });
  });

  it('pulls a single month, for a restatement', () => {
    expect(resolveRange({ today: '2026-09-01', windowStart: '2026-03', windowEnd: '2026-03' })).toEqual({
      windowStart: '2026-03-01',
      windowEnd: '2026-03-01',
    });
  });

  it('orders a reversed range rather than fetching nothing', () => {
    // Reversed, the month enumeration yields an empty list and the run reports
    // success having fetched nothing — the exact failure this screen exists to
    // make impossible.
    expect(resolveRange({ today: '2026-09-01', windowStart: '2026-06', windowEnd: '2026-02' })).toEqual({
      windowStart: '2026-02-01',
      windowEnd: '2026-06-01',
    });
  });

  it('refuses a range too long to finish, instead of dying part way', () => {
    const outcome = resolveRange({ today: '2026-09-01', windowStart: '2015-01', windowEnd: '2026-09' });
    expect(outcome).toHaveProperty('error');
  });

  it('treats one supplied end as a single month', () => {
    expect(resolveRange({ today: '2026-09-01', windowEnd: '2025-07' })).toEqual({
      windowStart: '2025-07-01',
      windowEnd: '2025-07-01',
    });
  });

  it('falls back to the trailing window when no range is given', () => {
    expect(resolveRange({ today: '2026-09-01', months: 12 })).toEqual({
      windowStart: '2025-10-01',
      windowEnd: '2026-09-01',
    });
  });

  it('ignores a malformed month rather than building a nonsense range', () => {
    expect(resolveRange({ today: '2026-09-01', windowStart: 'last year', months: 3 })).toEqual({
      windowStart: '2026-07-01',
      windowEnd: '2026-09-01',
    });
    expect(resolveRange({ today: '2026-09-01', windowStart: '2026-13', months: 3 })).toEqual({
      windowStart: '2026-07-01',
      windowEnd: '2026-09-01',
    });
  });
});
