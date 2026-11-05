'use client';

/**
 * The deals behind a bar.
 *
 * Westport: "Can we drill down into the bar graphs to see the data like we can
 * in HubSpot — if I click on the bar for September in the Deals Created by
 * Month graph, I would like a list of the deals for September."
 *
 * The deals are handed to the page once, through this provider, and every
 * chart refers to them by id. Handing each chart its own copy would send the
 * same deal to the browser once per chart it appears in.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import {
  billedIn,
  type BillingPeriod,
  type DealBilling,
  type DealBillingIndex,
  type DealRow,
} from '@/lib/dashboards/deal-rows';

const DealContext = createContext<Map<string, DealRow> | null>(null);
const BillingContext = createContext<DealBillingIndex | null>(null);

export function DealDrillProvider({
  deals,
  billing,
  children,
}: {
  deals: DealRow[];
  /** QuickBooks billing of the accounts behind won deals, for the Billed column. */
  billing?: DealBillingIndex | null;
  children: ReactNode;
}) {
  const byId = useMemo(() => new Map(deals.map((deal) => [deal.id, deal])), [deals]);
  return (
    <DealContext.Provider value={byId}>
      <BillingContext.Provider value={billing ?? null}>{children}</BillingContext.Provider>
    </DealContext.Provider>
  );
}

export function useDeals(): Map<string, DealRow> | null {
  return useContext(DealContext);
}

type SortKey = 'amount' | 'billed' | 'name' | 'owner' | 'closed' | 'created';

export function DealList({
  title,
  ids,
  onClose,
  emptyLabel = 'No deals.',
}: {
  title: string;
  ids: string[];
  onClose?: () => void;
  emptyLabel?: string;
}) {
  const deals = useDeals();
  const billing = useContext(BillingContext);
  const [sort, setSort] = useState<SortKey>('amount');
  const [period, setPeriod] = useState<BillingPeriod>({ kind: 'since_won' });

  const accountFor = (row: DealRow): DealBilling | null => {
    if (!billing || row.status !== 'Won') return null;
    const key = billing.accountOf[row.id];
    return key ? (billing.accounts[key] ?? null) : null;
  };
  const billedFor = (row: DealRow): number | null => {
    const account = accountFor(row);
    if (!account || !account.customer || !billing) return null;
    return billedIn(account, period, billing.asOf);
  };

  const rows = useMemo(() => {
    if (!deals) return [];
    const unique = [...new Set(ids)].map((id) => deals.get(id)).filter((row): row is DealRow => Boolean(row));
    const compare: Record<SortKey, (a: DealRow, b: DealRow) => number> = {
      amount: (a, b) => b.amount - a.amount,
      billed: (a, b) => (billedFor(b) ?? -1) - (billedFor(a) ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
      owner: (a, b) => a.owner.localeCompare(b.owner),
      closed: (a, b) => (b.closed ?? '').localeCompare(a.closed ?? ''),
      created: (a, b) => (b.created ?? '').localeCompare(a.created ?? ''),
    };
    return unique.sort(compare[sort]);
    // billedFor reads billing and period, both listed here.
  }, [deals, ids, sort, billing, period]);

  if (!deals) return null;
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  // The Billed column is for won deals, and only once QuickBooks billing is in.
  const showBilling = Boolean(billing && !billing.unavailable && rows.some((row) => row.status === 'Won'));
  // Billing is per account: an account with two won deals is counted once.
  const billedAccounts = new Map<string, number>();
  if (showBilling) {
    for (const row of rows) {
      const key = billing!.accountOf[row.id];
      const value = billedFor(row);
      if (key && value !== null) billedAccounts.set(key, value);
    }
  }
  const billedTotal = [...billedAccounts.values()].reduce((sum, value) => sum + value, 0);

  const header = (key: SortKey | null, label: string, align: 'left' | 'right' = 'left') => (
    <th
      className={`border-b px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${align === 'right' ? 'text-right' : 'text-left'}`}
      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      {key ? (
        <button
          type="button"
          onClick={() => setSort(key)}
          className="uppercase hover:text-[var(--text-primary)]"
          style={{ fontWeight: sort === key ? 700 : 600 }}
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <div
      className="mt-3 rounded-[var(--radius)] border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
    >
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <p className="text-[12px] font-semibold">
          {title}
          <span className="ml-2 font-normal text-[var(--text-muted)]">
            {formatNumber(rows.length, 'count')} deal{rows.length === 1 ? '' : 's'} ·{' '}
            {formatNumber(total, 'currency')}
            {showBilling ? ` booked · ${formatNumber(billedTotal, 'currency')} billed` : ''}
          </span>
        </p>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
          >
            <X size={12} aria-hidden /> Close
          </button>
        ) : null}
      </div>
      {showBilling ? <PeriodControl period={period} onChange={setPeriod} billing={billing!} /> : null}
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">{emptyLabel}</p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className={`w-full ${showBilling ? 'min-w-[940px]' : 'min-w-[760px]'} border-collapse text-[11.5px]`}>
            <thead className="sticky top-0" style={{ background: 'var(--surface-2)' }}>
              <tr>
                {header('name', 'Deal')}
                {header(null, 'Company')}
                {header('owner', 'Owner')}
                {header(null, 'Stage')}
                {header('amount', 'Amount', 'right')}
                {showBilling ? header('billed', 'Billed', 'right') : null}
                {showBilling ? header(null, 'Of booked', 'right') : null}
                {header('created', 'Created')}
                {header('closed', 'Closed')}
                {header(null, 'Review done')}
                {header(null, 'Lead source')}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <Cell strong title={row.name}>{row.name}</Cell>
                  <Cell title={row.company ?? undefined}>{row.company ?? '—'}</Cell>
                  <Cell>{row.owner}</Cell>
                  <Cell>
                    {row.stage}
                    {row.status !== 'Open' ? (
                      <span
                        className="ml-1.5 rounded-[3px] px-1 text-[10px]"
                        style={{
                          background: 'var(--surface-1)',
                          color: row.status === 'Won' ? 'var(--status-good)' : 'var(--status-critical)',
                        }}
                      >
                        {row.status}
                      </span>
                    ) : null}
                  </Cell>
                  <Cell align="right">{formatNumber(row.amount, 'currency')}</Cell>
                  {showBilling ? <BilledCells row={row} account={accountFor(row)} billed={billedFor(row)} /> : null}
                  <Cell>{row.created ?? '—'}</Cell>
                  <Cell>{row.closed ?? '—'}</Cell>
                  <Cell>{row.reviewed ?? '—'}</Cell>
                  <Cell>{row.source}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({
  children,
  align = 'left',
  strong,
  title,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  strong?: boolean;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={`max-w-[220px] truncate border-b px-2.5 py-1.5 ${align === 'right' ? 'tnum text-right' : ''} ${strong ? 'font-medium' : ''}`}
      style={{ borderColor: 'var(--border)' }}
    >
      {children}
    </td>
  );
}

function BilledCells({ row, account, billed }: { row: DealRow; account: DealBilling | null; billed: number | null }) {
  if (row.status !== 'Won') {
    return (
      <>
        <Cell align="right">—</Cell>
        <Cell align="right">—</Cell>
      </>
    );
  }
  if (!account || !account.customer || billed === null) {
    const why = 'No QuickBooks customer is matched to this account yet — Admin → Account matching';
    return (
      <>
        <Cell align="right" title={why}>
          <span className="text-[var(--text-muted)]">no match</span>
        </Cell>
        <Cell align="right" title={why}>—</Cell>
      </>
    );
  }
  // An account with several won deals has one bill: compared with all of them.
  const booked = account.dealCount > 1 ? account.booked : row.amount;
  const note = [
    `QuickBooks: ${account.customer}${account.confirmed ? '' : ' (suggested match — confirm in Admin)'}`,
    account.dealCount > 1
      ? `Billing is the account's: ${account.dealCount} won deals, ${formatNumber(account.booked, 'currency')} booked`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Cell align="right" title={note}>
        {formatNumber(billed, 'currency')}
        {account.confirmed ? null : <span className="ml-0.5 text-[var(--text-muted)]">*</span>}
      </Cell>
      <Cell align="right" title={note}>
        {booked > 0 ? `${Math.round((billed / booked) * 100)}%` : '—'}
      </Cell>
    </>
  );
}

/** Which period the Billed column totals. */
function PeriodControl({
  period,
  onChange,
  billing,
}: {
  period: BillingPeriod;
  onChange: (period: BillingPeriod) => void;
  billing: DealBillingIndex;
}) {
  const months: string[] = [];
  for (
    let cursor = new Date(`${billing.horizon.slice(0, 7)}-01T00:00:00Z`);
    cursor <= new Date(`${billing.asOf}T00:00:00Z`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  ) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  const label = (month: string) =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const thisMonth = billing.asOf.slice(0, 7);
  const custom = period.kind === 'custom' ? period : { kind: 'custom' as const, from: `${thisMonth.slice(0, 4)}-01`, to: thisMonth };

  const chip = (kind: BillingPeriod['kind'], text: string, next: BillingPeriod) => (
    <button
      type="button"
      onClick={() => onChange(next)}
      aria-pressed={period.kind === kind}
      className="rounded-[4px] border px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{
        borderColor: period.kind === kind ? 'var(--text-primary)' : 'var(--border)',
        background: period.kind === kind ? 'var(--text-primary)' : 'transparent',
        color: period.kind === kind ? 'var(--text-inverse)' : 'var(--text-secondary)',
      }}
    >
      {text}
    </button>
  );
  const select = (value: string, onPick: (month: string) => void, name: string) => (
    <select
      aria-label={name}
      value={value}
      onChange={(event) => onPick(event.target.value)}
      className="h-6 rounded-[4px] border px-1 text-[10.5px]"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
    >
      {months.map((month) => (
        <option key={month} value={month}>
          {label(month)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-[10.5px]" style={{ borderColor: 'var(--border)' }}>
      <span className="font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Billed in QuickBooks</span>
      {chip('since_won', 'Since won', { kind: 'since_won' })}
      {chip('ytd', `Year to date ${billing.asOf.slice(0, 4)}`, { kind: 'ytd' })}
      {chip('custom', 'Months', custom)}
      {period.kind === 'custom' ? (
        <>
          {select(period.from, (from) => onChange({ kind: 'custom', from, to: from > period.to ? from : period.to }), 'Billed from')}
          <span className="text-[var(--text-muted)]">to</span>
          {select(period.to, (to) => onChange({ kind: 'custom', from: to < period.from ? to : period.from, to }), 'Billed to')}
        </>
      ) : null}
      <span className="ml-auto text-[var(--text-muted)]">
        As of {billing.asOf} · billing is per account, net of credit memos, excluding tax · * suggested match
      </span>
    </div>
  );
}
