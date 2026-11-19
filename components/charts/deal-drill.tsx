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
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
/** Opens a deal's detail panel. */
const OpenDealContext = createContext<((dealId: string) => void) | null>(null);

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
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? byId.get(openId) : undefined;
  return (
    <DealContext.Provider value={byId}>
      <BillingContext.Provider value={billing ?? null}>
        <OpenDealContext.Provider value={setOpenId}>
          {children}
          {open ? <DealDetail deal={open} billing={billing ?? null} onClose={() => setOpenId(null)} /> : null}
        </OpenDealContext.Provider>
      </BillingContext.Provider>
    </DealContext.Provider>
  );
}

/** A deal's name that opens its detail — for boards and tables outside a DealList. */
export function DealLink({ dealId, children, className }: { dealId: string; children: ReactNode; className?: string }) {
  const openDeal = useContext(OpenDealContext);
  const deals = useContext(DealContext);
  if (!openDeal || !deals?.has(dealId)) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => openDeal(dealId)}
      className={`text-left underline-offset-2 hover:underline ${className ?? ''}`}
      title="Open the deal's details"
    >
      {children}
    </button>
  );
}

export function useDeals(): Map<string, DealRow> | null {
  return useContext(DealContext);
}

type SortKey =
  | 'amount' | 'billed' | 'ofBooked' | 'name' | 'company' | 'owner' | 'stage'
  | 'closed' | 'created' | 'reviewed' | 'source' | 'expectedClose';

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
  const openDeal = useContext(OpenDealContext);
  const [sort, setSort] = useState<SortKey>('amount');
  const [dir, setDir] = useState<1 | -1>(-1);
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
    // Ascending comparisons; the direction is applied once, below.
    const text = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').localeCompare(b ?? '');
    const ofBooked = (row: DealRow) => {
      const billed = billedFor(row);
      return billed === null || row.amount <= 0 ? -1 : billed / row.amount;
    };
    const compare: Record<SortKey, (a: DealRow, b: DealRow) => number> = {
      amount: (a, b) => a.amount - b.amount,
      billed: (a, b) => (billedFor(a) ?? -1) - (billedFor(b) ?? -1),
      ofBooked: (a, b) => ofBooked(a) - ofBooked(b),
      name: (a, b) => text(a.name, b.name),
      company: (a, b) => text(a.company, b.company),
      owner: (a, b) => text(a.owner, b.owner),
      stage: (a, b) => text(a.stage, b.stage),
      closed: (a, b) => text(a.closed, b.closed),
      created: (a, b) => text(a.created, b.created),
      reviewed: (a, b) => text(a.reviewed, b.reviewed),
      source: (a, b) => text(a.source, b.source),
      expectedClose: (a, b) => text(a.expectedClose, b.expectedClose),
    };
    return unique.sort((a, b) => compare[sort](a, b) * dir);
    // billedFor reads billing and period, both listed here.
  }, [deals, ids, sort, dir, billing, period]);

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

  // Every column sorts. Click again to reverse.
  const header = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const active = sort === key;
    return (
      <th
        aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : 'none'}
        className={`whitespace-nowrap border-b px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${align === 'right' ? 'text-right' : 'text-left'}`}
        style={{ borderColor: 'var(--border)', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
      >
        <button
          type="button"
          onClick={() => {
            if (active) setDir(dir === 1 ? -1 : 1);
            else {
              setSort(key);
              setDir(align === 'right' ? -1 : 1);
            }
          }}
          className="inline-flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
          title={`Sort by ${label.toLowerCase()}`}
        >
          {label}
          <span aria-hidden className="text-[9px]">{active ? (dir === 1 ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    );
  };

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
          <table className={`w-full ${showBilling ? 'min-w-[1020px]' : 'min-w-[840px]'} border-collapse text-[11.5px]`}>
            <thead className="sticky top-0" style={{ background: 'var(--surface-2)' }}>
              <tr>
                {header('name', 'Deal')}
                {header('company', 'Company')}
                {header('owner', 'Owner')}
                {header('stage', 'Stage')}
                {header('amount', 'Amount', 'right')}
                {showBilling ? header('billed', 'Billed', 'right') : null}
                {showBilling ? header('ofBooked', 'Of booked', 'right') : null}
                {header('created', 'Created')}
                {header('closed', 'Closed')}
                {header('expectedClose', 'Est. close')}
                {header('reviewed', 'Review done')}
                {header('source', 'Lead source')}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[var(--surface-1)]">
                  <Cell strong title={`${row.name} — open details`}>
                    <button
                      type="button"
                      onClick={() => openDeal?.(row.id)}
                      className="max-w-full truncate text-left underline-offset-2 hover:underline"
                    >
                      {row.name}
                    </button>
                  </Cell>
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
                  <Cell title={row.status === 'Open' ? 'Estimated close date (HubSpot)' : undefined}>
                    {row.status === 'Open' ? (row.expectedClose ?? '—') : '—'}
                  </Cell>
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

/** Everything about one deal, in one place — the "click on it to see more detail" Westport asked for. */
function DealDetail({ deal, billing, onClose }: { deal: DealRow; billing: DealBillingIndex | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const accountKey = billing?.accountOf[deal.id];
  const account = accountKey ? billing?.accounts[accountKey] : undefined;
  const sinceWon = account?.customer && billing ? billedIn(account, { kind: 'since_won' }, billing.asOf) : null;
  const ytd = account?.customer && billing ? billedIn(account, { kind: 'ytd' }, billing.asOf) : null;
  const fact = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[12.5px]">{value ?? '—'}</dd>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={deal.name}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div
        className="relative flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l shadow-2xl"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Deal</p>
            <h2 className="text-[16px] font-semibold leading-snug">{deal.name}</h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
              {deal.company ?? 'No company'} · {deal.owner}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
          >
            <X size={13} aria-hidden /> Close
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4">
          {fact('Amount', formatNumber(deal.amount, 'currency'))}
          {fact('Status', deal.status)}
          {fact('Stage now', deal.stage)}
          {fact('Days in this stage', deal.daysInStage === null ? '—' : `${deal.daysInStage} days`)}
          {fact('Created', deal.created)}
          {fact(deal.status === 'Open' ? 'Estimated close' : 'Closed', deal.status === 'Open' ? deal.expectedClose : deal.closed)}
          {fact('Compliance review done', deal.reviewed)}
          {fact('Lead source', deal.source)}
          {fact('Line of business', deal.lineOfBusiness)}
          {fact(deal.status === 'Won' ? 'Closed by' : 'Owner', deal.owner)}
          {fact('Created by', deal.createdBy)}
        </dl>

        {deal.status === 'Won' ? (
          <div className="mx-5 mb-4 rounded-[8px] border px-4 py-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Billed in QuickBooks</p>
            {account?.customer ? (
              <>
                <p className="mt-1 text-[12px]">
                  {account.customer}
                  {account.confirmed ? '' : ' · suggested match, confirm in Admin → Account matching'}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                  <div><span className="block text-[10.5px] text-[var(--text-muted)]">Since won</span>{formatNumber(sinceWon ?? 0, 'currency')}</div>
                  <div><span className="block text-[10.5px] text-[var(--text-muted)]">Year to date</span>{formatNumber(ytd ?? 0, 'currency')}</div>
                  <div>
                    <span className="block text-[10.5px] text-[var(--text-muted)]">Of booked</span>
                    {account.booked > 0 && sinceWon !== null ? `${Math.round((sinceWon / account.booked) * 100)}%` : '—'}
                  </div>
                </div>
              </>
            ) : (
              <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                No QuickBooks customer is matched to this account yet. Match it in Admin → Account matching.
              </p>
            )}
          </div>
        ) : null}

        <div className="px-5 pb-6">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
            Stage history
          </p>
          {deal.stageHistory.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">HubSpot has no stage history for this deal.</p>
          ) : (
            <ol className="relative space-y-2 border-l pl-4" style={{ borderColor: 'var(--border-strong)' }}>
              {deal.stageHistory.map((entry, index) => (
                <li key={`${entry.stage}-${entry.entered}-${index}`} className="relative">
                  <span
                    aria-hidden
                    className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2"
                    style={{
                      borderColor: index === deal.stageHistory.length - 1 ? 'var(--text-primary)' : 'var(--border-strong)',
                      background: 'var(--surface-1)',
                    }}
                  />
                  <p className="text-[12px] font-medium">{entry.stage}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)]">entered {entry.entered}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
