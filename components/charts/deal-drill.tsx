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
import type { DealRow } from '@/lib/dashboards/deal-rows';

const DealContext = createContext<Map<string, DealRow> | null>(null);

export function DealDrillProvider({ deals, children }: { deals: DealRow[]; children: ReactNode }) {
  const byId = useMemo(() => new Map(deals.map((deal) => [deal.id, deal])), [deals]);
  return <DealContext.Provider value={byId}>{children}</DealContext.Provider>;
}

export function useDeals(): Map<string, DealRow> | null {
  return useContext(DealContext);
}

type SortKey = 'amount' | 'name' | 'owner' | 'closed' | 'created';

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
  const [sort, setSort] = useState<SortKey>('amount');

  const rows = useMemo(() => {
    if (!deals) return [];
    const unique = [...new Set(ids)].map((id) => deals.get(id)).filter((row): row is DealRow => Boolean(row));
    const compare: Record<SortKey, (a: DealRow, b: DealRow) => number> = {
      amount: (a, b) => b.amount - a.amount,
      name: (a, b) => a.name.localeCompare(b.name),
      owner: (a, b) => a.owner.localeCompare(b.owner),
      closed: (a, b) => (b.closed ?? '').localeCompare(a.closed ?? ''),
      created: (a, b) => (b.created ?? '').localeCompare(a.created ?? ''),
    };
    return unique.sort(compare[sort]);
  }, [deals, ids, sort]);

  if (!deals) return null;
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

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
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">{emptyLabel}</p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full min-w-[760px] border-collapse text-[11.5px]">
            <thead className="sticky top-0" style={{ background: 'var(--surface-2)' }}>
              <tr>
                {header('name', 'Deal')}
                {header(null, 'Company')}
                {header('owner', 'Owner')}
                {header(null, 'Stage')}
                {header('amount', 'Amount', 'right')}
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
