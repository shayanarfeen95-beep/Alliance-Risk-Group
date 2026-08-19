'use client';

/**
 * Date range and the active-filter strip.
 *
 * ARG's leadership asked for a beginning/end date filter, and asked more
 * generally for the app to be as easy to read as HubSpot. Those turn out to be
 * the same request: HubSpot's dashboards are legible not because of how they
 * look but because the filters currently applied are *stated on the page* and
 * can be removed with one click. A control you have to open to discover the
 * state of is a control people stop trusting.
 *
 * So the strip only appears when something is actually filtering the view, and
 * every chip says what it is and removes itself.
 */
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { CalendarRange, User, X } from 'lucide-react';
import { RANGE_PRESETS, formatMonthLabel, type DateRange } from '@/lib/dashboards/range';

export function DateRangeControl({
  range,
  months,
}: {
  range: DateRange;
  months: Array<{ periodMonth: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  return (
    <div className="flex items-center gap-1.5">
      <CalendarRange size={13} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
      <label className="sr-only" htmlFor="date-range">
        Date range
      </label>
      <select
        id="date-range"
        value={range.preset}
        disabled={pending}
        onChange={(event) => {
          const preset = event.target.value;
          // Switching away from custom drops the explicit dates, so the preset
          // is what drives the range rather than silently losing to stale ones.
          apply(preset === 'custom' ? { range: preset } : { range: preset, from: null, to: null });
        }}
        className="h-8 rounded-[var(--radius)] border px-2.5 text-[12px] font-medium outline-none"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
      >
        {RANGE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id} title={preset.hint}>
            {preset.label}
          </option>
        ))}
      </select>

      {range.preset === 'custom' && (
        <>
          <MonthPicker
            label="From"
            value={range.from}
            months={months}
            onChange={(value) => apply({ from: value.slice(0, 7), range: 'custom' })}
          />
          <span className="text-[11px] text-[var(--text-muted)]">to</span>
          <MonthPicker
            label="To"
            value={range.to}
            months={months}
            onChange={(value) => apply({ to: value.slice(0, 7), range: 'custom' })}
          />
        </>
      )}
    </div>
  );
}

function MonthPicker({
  label,
  value,
  months,
  onChange,
}: {
  label: string;
  value: string;
  months: Array<{ periodMonth: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label className="sr-only" htmlFor={`range-${label}`}>
        {label}
      </label>
      <select
        id={`range-${label}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-[var(--radius)] border px-2 text-[12px] outline-none"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
      >
        {months.map((m) => (
          <option key={m.periodMonth} value={m.periodMonth}>
            {formatMonthLabel(m.periodMonth)}
          </option>
        ))}
      </select>
    </>
  );
}

export interface ActiveFilter {
  /** Query parameter this chip clears. */
  param: string;
  label: string;
  value: string;
  icon?: 'date' | 'person';
}

/**
 * What is currently filtering this page, and how to undo it.
 *
 * Rendered only when at least one filter is active — an always-present empty
 * strip is chrome that teaches the reader to ignore that part of the screen.
 */
export function ActiveFilters({ filters }: { filters: ActiveFilter[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (filters.length === 0) return null;

  function clear(params: string[]) {
    const next = new URLSearchParams(searchParams.toString());
    for (const param of params) next.delete(param);
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      <span className="text-[11px] text-[var(--text-muted)]">Filtered by</span>

      {filters.map((filter) => (
        <button
          key={filter.param}
          type="button"
          disabled={pending}
          onClick={() => clear([filter.param, ...(filter.param === 'range' ? ['from', 'to'] : [])])}
          title={`Remove the ${filter.label.toLowerCase()} filter`}
          className="group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
        >
          {filter.icon === 'person' ? (
            <User size={10} aria-hidden />
          ) : (
            <CalendarRange size={10} aria-hidden />
          )}
          <span className="text-[var(--text-muted)]">{filter.label}</span>
          <span className="font-medium text-[var(--text-primary)]">{filter.value}</span>
          <X size={10} aria-hidden className="opacity-40 group-hover:opacity-100" />
        </button>
      ))}

      {filters.length > 1 && (
        <button
          type="button"
          disabled={pending}
          onClick={() => clear([...filters.map((f) => f.param), 'from', 'to'])}
          className="rounded-full px-2 py-1 text-[11px] text-[var(--text-muted)] underline-offset-2 hover:underline disabled:opacity-50"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
