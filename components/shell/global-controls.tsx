'use client';

/**
 * The global control bar.
 *
 * §7: "A single global parameter drives every view — in Excel it is one cell.
 * In your build it is one date selector at the top of the app that every
 * dashboard reads. Changing it re-anchors PM, PY, YTD and budget lookups
 * everywhere at once."
 *
 * §9: every dashboard carries the same controls — reporting month, division
 * selector, accounting-basis label, open/closed period label, and last-refresh
 * timestamp.
 *
 * §5.3: "A stale dashboard that looks live is worse than no dashboard." The
 * refresh timestamp and the reconciliation status are part of the chrome, not
 * an admin screen someone has to go looking for.
 */
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { CircleAlert, CircleCheck, Clock, Lock, LockOpen, LoaderCircle } from 'lucide-react';
import { formatMonth } from '@/lib/semantic/periods';
import type { ShellData } from '@/lib/dashboards/shell';
import { resolveRange } from '@/lib/dashboards/range';
import { ActiveFilters, DateRangeControl, type ActiveFilter } from './filter-bar';

const CONSOLIDATED = 'ARG_TOTAL';

/** Pages whose figures are lists of dated events, and so honour the date filter. */
const RANGE_PAGES = ['/sales', '/hubspot'];

export function GlobalControls({ shell }: { shell: ShellData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const rawMonth = searchParams.get('month');
  const month = normaliseMonth(rawMonth) ?? shell.defaultMonth;
  const division = searchParams.get('division') ?? (shell.consolidatedAvailable ? CONSOLIDATED : shell.divisions[0]?.divisionCode ?? CONSOLIDATED);

  const selected = shell.months.find((m) => m.periodMonth === month);
  const isClosed = selected?.isClosed ?? false;

  // Resolved with the same function the server uses, so the control can never
  // display a range different from the one the page was rendered for.
  const range = resolveRange(
    {
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      range: searchParams.get('range') ?? undefined,
    },
    month,
    shell.months.map((m) => m.periodMonth),
  );

  const owner = searchParams.get('owner');

  // The date-range filter scopes lists of dated events (deals, meetings). The
  // financial pages are anchored on the month and ignore it, so offering it
  // there put a second, conflicting date control beside the month selector —
  // "the date ranges should be in one place".
  const usesRange = RANGE_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));

  const activeFilters: ActiveFilter[] = [
    ...(usesRange && range.preset !== 'ytd'
      ? [{ param: 'range', label: 'Dates', value: range.label, icon: 'date' as const }]
      : []),
    ...(owner ? [{ param: 'owner', label: 'Salesperson', value: owner, icon: 'person' as const }] : []),
  ];

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  return (
    <div
      className="sticky top-0 z-20 border-b backdrop-blur"
      style={{ background: 'color-mix(in srgb, var(--page) 88%, transparent)', borderColor: 'var(--border)' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:px-6">
        {/* One month selector, read by every dashboard. */}
        <label
          htmlFor="reporting-month"
          className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
        >
          Month
        </label>
        <select
          id="reporting-month"
          value={month}
          onChange={(event) => update('month', event.target.value.slice(0, 7))}
          className="h-8 rounded-[var(--radius)] border px-2.5 text-[12px] font-medium outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
        >
          {shell.months.map((m) => (
            <option key={m.periodMonth} value={m.periodMonth}>
              {formatMonth(m.periodMonth)}
            </option>
          ))}
        </select>

        {/* §9: any one division, or ARG Total, or all five side by side. */}
        <label className="sr-only" htmlFor="division">
          Division
        </label>
        <select
          id="division"
          value={division}
          onChange={(event) => update('division', event.target.value)}
          className="h-8 rounded-[var(--radius)] border px-2.5 text-[12px] font-medium outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
        >
          {shell.consolidatedAvailable ? <option value={CONSOLIDATED}>ARG Total</option> : null}
          {shell.divisions.map((d) => (
            <option key={d.divisionCode} value={d.divisionCode}>
              {d.divisionName}
            </option>
          ))}
        </select>

        {usesRange ? <DateRangeControl range={range} months={shell.months} /> : null}

        {pending ? (
          <LoaderCircle size={13} className="animate-spin text-[var(--text-muted)]" aria-label="Loading" />
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Rule 3: every financial view states its basis on its face. */}
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-medium capitalize"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            title="ARG reports on the accrual basis. Cash and accrual are never mixed silently."
          >
            {shell.accountingBasis} basis
          </span>

          <PeriodBadge isClosed={isClosed} month={month} />
          <ReconBadge
            failed={shell.recon.failed}
            total={shell.recon.total}
            failures={shell.recon.failures}
          />
          <RefreshBadge iso={shell.lastRefreshedAt} />
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div
          className="border-t px-6 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          <ActiveFilters filters={activeFilters} />
        </div>
      )}
    </div>
  );
}

function normaliseMonth(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

function PeriodBadge({ isClosed, month }: { isClosed: boolean; month: string }) {
  const label = formatMonth(month);
  return isClosed ? (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
      title={`The books for ${label} are closed. These figures are final.`}
    >
      <Lock size={11} aria-hidden />
      {label} closed · final
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: 'var(--status-warning-wash)', color: 'var(--status-warning)' }}
      title={`The books for ${label} have not been closed yet, so these figures come straight from QuickBooks as it stands today and can still change — a late invoice, an accrual or a reclass. They become final when the month is closed.`}
    >
      <LockOpen size={11} aria-hidden />
      Books not closed · may change
    </span>
  );
}

/**
 * The data-check status, and what is behind it.
 *
 * This used to be a bare "3 failing" linking to a page that did not exist. A
 * red number nobody can open is worse than no number: it says something is
 * wrong without saying what, or whether the figure in front of you is affected.
 * It now opens in place and lists each failing check in words.
 */
function ReconBadge({
  failed,
  total,
  failures,
}: {
  failed: number;
  total: number;
  failures: Array<{ name: string; month: string | null; detail: string }>;
}) {
  if (total === 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        title="The data checks run after every pull. None has run yet."
      >
        <CircleAlert size={11} aria-hidden />
        Data checks not run yet
      </span>
    );
  }

  const ok = failed === 0;
  return (
    <details className="relative">
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
        style={{
          background: ok ? 'var(--status-good-wash)' : 'var(--status-critical-wash)',
          color: ok ? 'var(--status-good)' : 'var(--status-critical)',
        }}
      >
        {ok ? <CircleCheck size={11} aria-hidden /> : <CircleAlert size={11} aria-hidden />}
        {ok ? 'Ties to QuickBooks' : `${failed} data check${failed === 1 ? '' : 's'} failing`}
      </summary>
      <div
        className="absolute right-0 z-30 mt-1.5 w-[min(420px,85vw)] rounded-[var(--radius)] border p-3 text-[11.5px] leading-relaxed shadow-lg"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
      >
        <p className="mb-2">
          After every pull, {total} automatic checks confirm the figures agree with QuickBooks: each
          division&apos;s P&amp;L ties to its accounts, ARG Total ties to QuickBooks&apos; own total, the
          balance sheet balances and every class is assigned.
        </p>
        {ok ? (
          <p style={{ color: 'var(--status-good)' }}>All {total} checks pass.</p>
        ) : (
          <ul className="space-y-2">
            {failures.map((failure, index) => (
              <li key={index} className="border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                <span className="font-medium text-[var(--text-primary)]">
                  {failure.name}
                  {failure.month ? ` — ${formatMonth(failure.month)}` : ''}
                </span>
                <br />
                {failure.detail}
              </li>
            ))}
            {failed > failures.length ? (
              <li className="text-[var(--text-muted)]">…and {failed - failures.length} more in Admin → Data.</li>
            ) : null}
          </ul>
        )}
      </div>
    </details>
  );
}

function RefreshBadge({ iso }: { iso: string | null }) {
  const label = iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'never';

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"
      title="Timestamp of the last successful data refresh."
    >
      <Clock size={11} aria-hidden />
      Refreshed {label}
    </span>
  );
}
