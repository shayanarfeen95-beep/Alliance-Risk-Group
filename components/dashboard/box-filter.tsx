'use client';

/**
 * The filter that belongs to one box.
 *
 * Every tile, chart and table carries one. Closed, it is a single small control
 * that says nothing — a dashboard of twenty boxes must not read as a dashboard
 * of twenty filter bars. Open, it offers the two things a reader actually wants
 * to vary on a single box: which division and which month.
 *
 * A box that has been moved off the page filter says so on its face, in words,
 * and clears in one click. That is the same principle as the page-level filter
 * strip: a control whose state you have to open it to discover is a control
 * people stop trusting.
 */
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { formatMonth } from '@/lib/semantic/periods';
import {
  boxParamName,
  encodeBoxOverride,
  type BoxFilterField,
  type BoxFilterOptions,
  type BoxFilterState,
} from '@/lib/dashboards/box-filter';

const CONSOLIDATED = 'ARG_TOTAL';
/** Sentinel for "whatever the page filter says" — an empty option value. */
const INHERIT = '';

export interface BoxFilterProps {
  /** The scope the box actually rendered at. */
  state: BoxFilterState;
  options: BoxFilterOptions;
  /**
   * Which fields to offer. A table that already shows every division has
   * nothing to say about a division filter, and offering one that changes
   * nothing is worse than offering none.
   */
  fields?: BoxFilterField[];
  align?: 'left' | 'right';
}

export function BoxFilter({
  state,
  options,
  fields = ['division', 'month'],
  align = 'right',
}: BoxFilterProps) {
  const { boxId, divisionCode, month, divisionOverridden, monthOverridden, overrideLabel } = state;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const param = boxParamName(boxId);

  function apply(next: { divisionCode?: string; month?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    const encoded = encodeBoxOverride(next);

    if (!next.divisionCode && !next.month) params.delete(param);
    else params.set(param, encoded);

    // scroll:false — changing one box a page down should not throw the reader
    // back to the top of the dashboard.
    startTransition(() => router.push(`${pathname}?${params.toString()}`, { scroll: false }));
  }

  const current = {
    divisionCode: divisionOverridden ? divisionCode : undefined,
    month: monthOverridden ? month : undefined,
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      {overrideLabel ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => apply({})}
          title="Clear this box's filter and follow the page filter again"
          className="group inline-flex max-w-[190px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          <span className="truncate font-medium text-[var(--text-primary)]">{overrideLabel}</span>
          <X size={9} aria-hidden className="opacity-40 group-hover:opacity-100" />
        </button>
      ) : null}

      <details className="relative">
        <summary
          className="flex h-6 w-6 cursor-pointer list-none items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: overrideLabel ? 'var(--text-primary)' : 'var(--text-muted)' }}
          title="Filter just this box"
          aria-label={`Filter this box${overrideLabel ? ` — currently ${overrideLabel}` : ''}`}
        >
          <SlidersHorizontal size={12} aria-hidden />
        </summary>

        <div
          className={`absolute top-7 z-20 w-[224px] rounded-[var(--radius)] border p-3 shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          style={{
            background: 'var(--surface-raised)',
            borderColor: 'var(--border-strong)',
          }}
        >
          <p className="mb-2 text-[10.5px] leading-snug text-[var(--text-muted)]">
            This box only. Leave a field on <em>Page filter</em> to follow the bar at the top.
          </p>

          {fields.includes('division') ? (
            <Field label="Division">
            <select
              value={current.divisionCode ?? INHERIT}
              disabled={pending}
              onChange={(event) =>
                apply({ ...current, divisionCode: event.target.value || undefined })
              }
              className="h-7 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
              style={{
                background: 'var(--surface-1)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
              }}
            >
              <option value={INHERIT}>Page filter — {options.pageDivisionLabel}</option>
              {options.consolidatedAvailable ? <option value={CONSOLIDATED}>ARG Total</option> : null}
              {options.divisions.map((division) => (
                <option key={division.divisionCode} value={division.divisionCode}>
                  {division.divisionName}
                </option>
              ))}
            </select>
          </Field>
          ) : null}

          {fields.includes('month') ? (
            <Field label="Month">
            <select
              value={current.month ?? INHERIT}
              disabled={pending}
              onChange={(event) => apply({ ...current, month: event.target.value || undefined })}
              className="h-7 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
              style={{
                background: 'var(--surface-1)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
              }}
            >
              <option value={INHERIT}>Page filter — {formatMonth(options.pageMonth)}</option>
              {options.months.map((value) => (
                <option key={value} value={value}>
                  {formatMonth(value)}
                </option>
              ))}
            </select>
          </Field>
          ) : null}

          {overrideLabel ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => apply({})}
              className="mt-2 w-full rounded-[5px] border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            >
              Match the page filter
            </button>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block last:mb-0">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
