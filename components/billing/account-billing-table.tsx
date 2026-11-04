'use client';

/**
 * Every won account beside what it has billed, with the detail one click away.
 *
 * A row reads left to right the way the question is asked: who, what was won,
 * what should have billed by now, what has, and so whether it is on track.
 * Opening a row shows the deals behind it, its billing month by month and how
 * its QuickBooks customer was found — because a figure that depends on a match
 * has to show the match.
 */
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatAxisTick, formatNumber } from '@/lib/format';
import type { AccountBillingRow, BillingStatus } from '@/lib/billing/accounts';

const STATUS_LABEL: Record<BillingStatus, string> = {
  NO_MATCH: 'No QuickBooks customer',
  WAITING: 'Waiting for first invoice',
  NOT_BILLING: 'Not billing',
  BEHIND: 'Behind pace',
  ON_PACE: 'On pace',
  AHEAD: 'Ahead of pace',
  REACHED: 'Contract value billed',
};

const STATUS_TONE: Record<BillingStatus, { bg: string; fg: string }> = {
  NO_MATCH: { bg: 'var(--surface-2)', fg: 'var(--text-secondary)' },
  WAITING: { bg: 'var(--surface-2)', fg: 'var(--text-secondary)' },
  NOT_BILLING: { bg: 'var(--status-critical-wash)', fg: 'var(--status-critical)' },
  BEHIND: { bg: 'var(--status-warning-wash, var(--surface-2))', fg: 'var(--status-warning)' },
  ON_PACE: { bg: 'var(--status-good-wash)', fg: 'var(--status-good)' },
  AHEAD: { bg: 'var(--status-good-wash)', fg: 'var(--status-good)' },
  REACHED: { bg: 'var(--status-good-wash)', fg: 'var(--status-good)' },
};

const MATCH_LABEL: Record<AccountBillingRow['match']['method'], string> = {
  CONFIRMED: 'confirmed in Admin',
  DOMAIN: 'matched by domain — confirm in Admin',
  NAME: 'matched by name — confirm in Admin',
  NONE: 'no match found',
  REJECTED: 'marked as no QuickBooks customer',
};

type Filter = 'all' | 'attention' | BillingStatus;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'ON_PACE', label: 'On pace' },
  { id: 'AHEAD', label: 'Ahead' },
  { id: 'WAITING', label: 'Waiting' },
  { id: 'NO_MATCH', label: 'No match' },
];

export function StatusBadge({ status }: { status: BillingStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

export function AccountBillingTable({ rows, initialFilter = 'all' }: { rows: AccountBillingRow[]; initialFilter?: Filter }) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: rows.length, attention: 0 };
    for (const row of rows) {
      out[row.status] = (out[row.status] ?? 0) + 1;
      if (row.status === 'NOT_BILLING' || row.status === 'BEHIND') out.attention! += 1;
    }
    return out;
  }, [rows]);

  const shown = rows.filter((row) => {
    if (filter === 'attention' && row.status !== 'NOT_BILLING' && row.status !== 'BEHIND') return false;
    if (filter !== 'all' && filter !== 'attention' && row.status !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!row.account.toLowerCase().includes(q) && !row.owners.some((owner) => owner.toLowerCase().includes(q))) {
        return false;
      }
    }
    return true;
  });

  const th = (label: string, align: 'left' | 'right' = 'right') => (
    <th
      className={`whitespace-nowrap border-b px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${align === 'left' ? 'text-left' : 'text-right'}`}
      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      {label}
    </th>
  );
  const td = 'border-b px-2.5 py-2 align-top';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={filter === option.id}
              className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: filter === option.id ? 'var(--text-primary)' : 'var(--border)',
                background: filter === option.id ? 'var(--text-primary)' : 'transparent',
                color: filter === option.id ? 'var(--text-inverse)' : 'var(--text-secondary)',
              }}
            >
              {option.label} · {counts[option.id] ?? 0}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find an account or owner"
          className="ml-auto w-56 rounded-[5px] border px-2 py-1 text-[11.5px]"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
        />
      </div>

      <div className="scroll-x max-h-[640px] overflow-auto">
        <table className="w-full min-w-[1040px] border-collapse text-[12px]">
          <thead className="sticky top-0 z-[1]" style={{ background: 'var(--surface-1)' }}>
            <tr>
              {th('Account', 'left')}
              {th('Owner', 'left')}
              {th('Won')}
              {th('Live since')}
              {th('Booked')}
              {th('Expected by now')}
              {th('Billed since won')}
              {th('Of expected')}
              {th('Of contract')}
              {th('Last invoice')}
              {th('Status', 'left')}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const isOpen = open === row.key;
              return (
                <Fragment key={row.key}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : row.key)}
                    className="cursor-pointer hover:bg-[var(--surface-2)]"
                    style={isOpen ? { background: 'var(--surface-2)' } : undefined}
                  >
                    <td className={td} style={{ borderColor: 'var(--border)' }}>
                      <span className="flex items-start gap-1 font-medium">
                        {isOpen ? <ChevronDown size={13} className="mt-0.5 shrink-0" /> : <ChevronRight size={13} className="mt-0.5 shrink-0" />}
                        <span>
                          {row.account}
                          <span className="block text-[10.5px] font-normal text-[var(--text-muted)]">
                            {row.match.customerName ? `QuickBooks: ${row.match.customerName}` : MATCH_LABEL[row.match.method]}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className={td} style={{ borderColor: 'var(--border)' }}>{row.owners.join(', ')}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{row.wonOn}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{row.goLiveOn}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{formatNumber(row.booked, 'currency')}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{formatNumber(row.expectedToDate, 'currency')}</td>
                    <td className={`${td} tnum text-right font-medium`} style={{ borderColor: 'var(--border)' }}>{formatNumber(row.billedSinceWon, 'currency')}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{pct(row.pctOfExpected)}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{pct(row.pctOfContract)}</td>
                    <td className={`${td} tnum text-right`} style={{ borderColor: 'var(--border)' }}>{row.lastInvoice ?? '—'}</td>
                    <td className={td} style={{ borderColor: 'var(--border)' }}><StatusBadge status={row.status} /></td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={11} className="border-b px-4 py-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
                        <AccountDetail row={row} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">No account matches these filters.</p>
        ) : null}
      </div>
    </div>
  );
}

function AccountDetail({ row }: { row: AccountBillingRow }) {
  const max = Math.max(1, ...row.monthly.map((point) => Math.abs(point.billed)));
  return (
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          Deals won
        </p>
        <table className="w-full border-collapse text-[11.5px]">
          <tbody>
            {row.deals.map((deal) => (
              <tr key={deal.id}>
                <td className="py-1 pr-3 font-medium">{deal.name}</td>
                <td className="py-1 pr-3 text-[var(--text-secondary)]">{deal.owner}</td>
                <td className="py-1 pr-3 text-[var(--text-secondary)]">{deal.stage}</td>
                <td className="tnum py-1 pr-3 text-right">{formatNumber(deal.amount, 'currency')}</td>
                <td className="tnum py-1 pr-3 text-[var(--text-muted)]">won {deal.closed}</td>
                <td className="tnum py-1 text-[var(--text-muted)]">live {deal.goLive}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          QuickBooks customer: <strong>{row.match.customerName ?? 'none'}</strong> ({MATCH_LABEL[row.match.method]}).{' '}
          {row.match.suggestions.length ? `Possible matches: ${row.match.suggestions.map((s) => s.name).join(', ')}. ` : ''}
          <Link href="/admin?tab=accounts" className="underline underline-offset-2">
            Change the match
          </Link>
        </p>
        {row.billedBeforeWon > 0 ? (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            This customer was already billing before the win: {formatNumber(row.billedBeforeWon, 'currency')} in the 12
            months before {row.wonOn}. Billing since the win includes that existing business.
          </p>
        ) : null}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          Billed by month since won · {row.invoiceCount} invoice{row.invoiceCount === 1 ? '' : 's'}
        </p>
        <div className="flex h-[96px] items-end gap-1">
          {row.monthly.map((point) => (
            <div key={point.month} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`${point.month.slice(0, 7)}: ${formatNumber(point.billed, 'currency')}`}>
              <span className="mb-0.5 text-[9px] text-[var(--text-muted)]">
                {point.billed ? formatAxisTick(point.billed, 'currency') : ''}
              </span>
              <div
                className="w-full rounded-t-[3px]"
                style={{ height: `${Math.max(2, (Math.abs(point.billed) / max) * 70)}px`, background: point.billed ? 'var(--series-1)' : 'var(--surface-1)' }}
              />
              <span className="mt-1 text-[9px] text-[var(--text-muted)]">{point.month.slice(2, 7)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
