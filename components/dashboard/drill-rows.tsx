'use client';

/**
 * A summary table whose rows open the deals behind them.
 *
 * Westport, November 2026: "None of the fields appear to be clickable to dig
 * deeper into the data." Clicking a stage or a salesperson lists their deals
 * underneath, each of which opens its own detail. Needs a DealDrillProvider.
 */
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DealList } from '@/components/charts/deal-drill';

export interface DrillRow {
  id: string;
  /** Formatted cells; the first is the row's name. */
  cells: string[];
  dealIds: string[];
  /** Title of the list it opens. */
  listTitle: string;
  muted?: boolean;
}

export function DrillRows({
  headers,
  rows,
  emptyLabel = 'No deals.',
}: {
  headers: Array<{ label: string; align?: 'left' | 'right' }>;
  rows: DrillRow[];
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <p className="text-[12px] text-[var(--text-muted)]">{emptyLabel}</p>;

  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={header.label}
                className={`whitespace-nowrap border-b px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${
                  (header.align ?? (index === 0 ? 'left' : 'right')) === 'left' ? 'text-left' : 'text-right'
                }`}
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isOpen = open === row.id;
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={() => setOpen(isOpen ? null : row.id)}
                  className="cursor-pointer hover:bg-[var(--surface-2)]"
                  style={isOpen ? { background: 'var(--surface-2)' } : undefined}
                  title="Click to list the deals"
                >
                  {row.cells.map((cell, index) => (
                    <td
                      key={index}
                      className={`border-b px-2.5 py-2 ${
                        (headers[index]?.align ?? (index === 0 ? 'left' : 'right')) === 'left' ? 'text-left' : 'tnum text-right'
                      }`}
                      style={{
                        borderColor: 'var(--border)',
                        color: row.muted || index > 1 ? 'var(--text-secondary)' : undefined,
                      }}
                    >
                      {index === 0 ? (
                        <span className="inline-flex items-center gap-1 font-medium">
                          {isOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                          {cell}
                        </span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
                {isOpen ? (
                  <tr>
                    <td colSpan={headers.length} className="border-b px-1 pb-3" style={{ borderColor: 'var(--border)' }}>
                      <DealList title={row.listTitle} ids={row.dealIds} onClose={() => setOpen(null)} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
