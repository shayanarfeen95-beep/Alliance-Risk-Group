'use client';

/**
 * The one date control, on every page.
 *
 * Westport, November 2026: "provide calendar-based start and end dates
 * supporting custom daily ranges, rather than limiting reporting to individual
 * months or year-to-date. Retain useful preset ranges such as current and
 * previous month" — and the old control "has months and years listed and has
 * Year to Date, but you cannot select one vs. the other."
 *
 * So there is one control: a preset, or a start and an end day picked on a
 * calendar. The month the period ends in anchors the P&L's month column and
 * every prior-month / prior-year comparison; the period itself is what lists
 * and totals are counted over.
 */
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { RANGE_PRESETS, daysForPreset, type DateRange, type RangePreset } from '@/lib/dashboards/range';

export function PeriodControl({
  range,
  earliestDay,
  latestDay,
  onApply,
}: {
  range: DateRange;
  /** The first day history is loaded for. */
  earliestDay: string;
  /** The last day that may be picked (the end of this year). */
  latestDay: string;
  onApply: (next: { preset: RangePreset; fromDay: string; toDay: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fromDay, setFromDay] = useState(range.fromDay);
  const [toDay, setToDay] = useState(range.toDay);
  const panel = useRef<HTMLDivElement>(null);
  const presetLabel = RANGE_PRESETS.find((preset) => preset.id === range.preset)?.label ?? 'Custom dates';

  useEffect(() => {
    setFromDay(range.fromDay);
    setToDay(range.toDay);
  }, [range.fromDay, range.toDay]);

  // Close on a click outside or Escape, the way a menu behaves.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (preset: RangePreset) => {
    if (preset === 'custom') return;
    const days = daysForPreset(preset);
    setOpen(false);
    onApply({ preset, ...days });
  };

  const valid = Boolean(fromDay && toDay && fromDay <= toDay);

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-2 rounded-[var(--radius)] border px-2.5 text-[12px] font-medium"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
      >
        <CalendarDays size={14} aria-hidden className="text-[var(--text-muted)]" />
        <span className="text-[var(--text-muted)]">{presetLabel}</span>
        <span className="tnum">{range.label}</span>
        <ChevronDown size={13} aria-hidden className="text-[var(--text-muted)]" />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Choose a period"
          className="absolute left-0 top-10 z-40 flex w-[min(560px,calc(100vw-32px))] flex-col gap-3 rounded-[10px] border p-3 shadow-xl sm:flex-row"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
        >
          <div className="flex flex-col gap-0.5 sm:w-44">
            <p className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
              Quick picks
            </p>
            {RANGE_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => pick(preset.id)}
                title={preset.hint}
                className="rounded-[6px] px-2 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                style={{
                  background: range.preset === preset.id ? 'var(--surface-2)' : undefined,
                  fontWeight: range.preset === preset.id ? 600 : 400,
                }}
              >
                {preset.label}
                <span className="block text-[10.5px] font-normal text-[var(--text-muted)]">{preset.hint}</span>
              </button>
            ))}
          </div>

          <form
            className="flex flex-1 flex-col gap-2.5 border-t pt-3 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0"
            style={{ borderColor: 'var(--border)' }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              setOpen(false);
              onApply({ preset: 'custom', fromDay, toDay });
            }}
          >
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
              Custom dates
            </p>
            <label className="flex flex-col gap-1 text-[11.5px]">
              Start date
              <input
                type="date"
                value={fromDay}
                min={earliestDay}
                max={latestDay}
                onChange={(event) => setFromDay(event.target.value)}
                className="h-8 rounded-[6px] border px-2 text-[12px]"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11.5px]">
              End date
              <input
                type="date"
                value={toDay}
                min={earliestDay}
                max={latestDay}
                onChange={(event) => setToDay(event.target.value)}
                className="h-8 rounded-[6px] border px-2 text-[12px]"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
              />
            </label>
            {!valid ? (
              <p className="text-[11px]" style={{ color: 'var(--status-critical)' }}>
                The end date must be on or after the start date.
              </p>
            ) : null}
            <p className="text-[10.5px] leading-snug text-[var(--text-muted)]">
              Deals, billing and other dated lists count these exact days. The P&amp;L comes from QuickBooks by month, so
              Finance totals the whole months the dates fall in and says which.
            </p>
            <button
              type="submit"
              disabled={!valid}
              className="mt-auto h-8 rounded-[6px] text-[12px] font-semibold disabled:opacity-40"
              style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
            >
              Apply dates
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
