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

  const activeFilters: ActiveFilter[] = [
    ...(range.preset !== 'ytd'
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5">
        {/* One month selector, read by every dashboard. */}
        <label className="sr-only" htmlFor="reporting-month">
          Reporting month
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
              {m.isClosed ? '' : ' — open'}
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

        <DateRangeControl range={range} months={shell.months} />

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

          <PeriodBadge isClosed={isClosed} />
          <ReconBadge failed={shell.recon.failed} total={shell.recon.total} />
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

function PeriodBadge({ isClosed }: { isClosed: boolean }) {
  return isClosed ? (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
      title="Books are closed for this month. Figures are final unless restated through a new version."
    >
      <Lock size={11} aria-hidden />
      Closed
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: 'var(--status-warning-wash)', color: 'var(--status-warning)' }}
      title="Books are not closed. Everything on this page is preliminary and will change."
    >
      <LockOpen size={11} aria-hidden />
      Open — preliminary
    </span>
  );
}

function ReconBadge({ failed, total }: { failed: number; total: number }) {
  if (total === 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        title="Reconciliation checks have not run yet."
      >
        <CircleAlert size={11} aria-hidden />
        No checks run
      </span>
    );
  }

  const ok = failed === 0;
  return (
    <a
      href="/admin/reconciliation"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{
        background: ok ? 'var(--status-good-wash)' : 'var(--status-critical-wash)',
        color: ok ? 'var(--status-good)' : 'var(--status-critical)',
      }}
      title={
        ok
          ? `All ${total} reconciliation checks pass. Figures tie to source.`
          : `${failed} of ${total} reconciliation checks are failing. Figures on this page may not tie to source.`
      }
    >
      {ok ? <CircleCheck size={11} aria-hidden /> : <CircleAlert size={11} aria-hidden />}
      {ok ? `${total} checks pass` : `${failed} failing`}
    </a>
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
