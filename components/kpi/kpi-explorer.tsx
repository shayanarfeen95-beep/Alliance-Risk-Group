'use client';

/**
 * The KPI dictionary, as something you can search.
 *
 * Every definition still comes from the semantic-layer registry at request time;
 * this only makes forty-odd of them findable. Filters live in the URL, so a link
 * to "Finance metrics from QuickBooks" opens exactly that, and the month and
 * division chosen at the top of the app are kept as filters change.
 */
import { useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpRight, ArrowDown, ArrowUp, Search, X } from 'lucide-react';

export interface KpiItem {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  definition: string;
  formula: string;
  source: string;
  sourceKey: 'quickbooks' | 'hubspot' | 'sheets' | 'mixed' | 'other';
  refresh: string;
  higherIsBetter: boolean;
  isSpec: boolean;
  workbookLabel?: string;
  notes?: string;
  specReference: string;
  /** The figure for the selected month and division, formatted, or why it is not available. */
  current: { value: string | null; unavailable: string | null; preliminary: boolean };
  href: string;
}

const SOURCES: Array<{ key: KpiItem['sourceKey'] | 'all'; label: string }> = [
  { key: 'all', label: 'All sources' },
  { key: 'quickbooks', label: 'QuickBooks' },
  { key: 'hubspot', label: 'HubSpot' },
  { key: 'sheets', label: 'Google Sheets' },
  { key: 'mixed', label: 'Combined' },
];

export function KpiExplorer({
  items,
  categories,
  scopeLabel,
}: {
  items: KpiItem[];
  categories: Array<{ key: string; label: string; blurb: string }>;
  scopeLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const query = params.get('q') ?? '';
  const category = params.get('category') ?? 'all';
  const source = params.get('source') ?? 'all';

  function update(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (source !== 'all' && item.sourceKey !== source) return false;
      if (!needle) return true;
      return [item.name, item.id, item.definition, item.formula, item.workbookLabel ?? '', item.source]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, category, source]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [items]);

  return (
    <div className="space-y-5">
      {/* Filters: one row above the results. */}
      <div
        className="md:sticky md:top-[53px] z-10 space-y-2.5 rounded-[var(--radius-lg)] border p-3 backdrop-blur"
        style={{ background: 'color-mix(in srgb, var(--surface-1) 92%, transparent)', borderColor: 'var(--border)' }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search metrics</span>
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="search"
              defaultValue={query}
              onChange={(event) => update('q', event.target.value)}
              placeholder="Search by name, formula or what it measures — e.g. “margin”, “A/R”, “pipeline”"
              className="h-9 w-full rounded-[var(--radius)] border pl-8 pr-3 text-[12.5px] outline-none"
              style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
            />
          </label>
          <select
            aria-label="Source system"
            value={source}
            onChange={(event) => update('source', event.target.value)}
            className="h-9 rounded-[var(--radius)] border px-2.5 text-[12px] outline-none"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
          >
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          {query || category !== 'all' || source !== 'all' ? (
            <button
              type="button"
              onClick={() => router.replace(`${pathname}?${stripFilters(params)}`, { scroll: false })}
              className="inline-flex h-9 items-center gap-1 rounded-[var(--radius)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              <X size={13} aria-hidden /> Clear
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
          <Pill active={category === 'all'} onClick={() => update('category', 'all')}>
            All <Count n={items.length} />
          </Pill>
          {categories.map((c) => (
            <Pill key={c.key} active={category === c.key} onClick={() => update('category', c.key)}>
              {c.label} <Count n={counts.get(c.key) ?? 0} />
            </Pill>
          ))}
        </div>
      </div>

      <p className="text-[11.5px] text-[var(--text-muted)]">
        {filtered.length} of {items.length} metrics · live values for {scopeLabel}
      </p>

      {filtered.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border px-4 py-8 text-center text-[12.5px] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
          No metric matches those filters.
        </p>
      ) : (
        categories.map((c) => {
          const group = filtered.filter((item) => item.category === c.key);
          if (!group.length) return null;
          return (
            <section key={c.key} className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-[14px] font-semibold tracking-tight">{c.label}</h2>
                <p className="text-[11.5px] text-[var(--text-muted)]">{c.blurb}</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {group.map((item) => (
                  <KpiCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function stripFilters(params: URLSearchParams): string {
  const next = new URLSearchParams(params.toString());
  for (const key of ['q', 'category', 'source']) next.delete(key);
  return next.toString();
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors"
      style={{
        background: active ? 'var(--text-primary)' : 'var(--surface-1)',
        color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
        borderColor: active ? 'var(--text-primary)' : 'var(--border-strong)',
      }}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums opacity-70">{n}</span>;
}

function KpiCard({ item }: { item: KpiItem }) {
  return (
    <article
      className="flex flex-col rounded-[var(--radius-lg)] border p-4"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-card)' }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-tight">{item.name}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
            <code className="rounded px-1 py-px" style={{ background: 'var(--surface-2)' }}>
              {item.id}
            </code>
            {item.isSpec ? <Badge tone="info">Specification KPI</Badge> : null}
            <Badge tone="neutral">
              {item.higherIsBetter ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden />}
              {item.higherIsBetter ? 'Higher is better' : 'Lower is better'}
            </Badge>
          </p>
        </div>
        <div className="shrink-0 text-right">
          {item.current.value !== null ? (
            <>
              <p className="text-[18px] font-semibold leading-none tracking-tight tabular-nums">{item.current.value}</p>
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">{item.current.preliminary ? 'preliminary' : 'this month'}</p>
            </>
          ) : (
            <p className="max-w-[170px] text-[10.5px] leading-snug text-[var(--text-muted)]" title={item.current.unavailable ?? undefined}>
              Not available for this scope
            </p>
          )}
        </div>
      </header>

      <p className="mt-2.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{item.definition}</p>

      <div className="mt-3 rounded-[var(--radius)] px-3 py-2 font-mono text-[11.5px] leading-relaxed" style={{ background: 'var(--surface-2)' }}>
        {item.formula}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
        <Def label="Source">{item.source}</Def>
        <Def label="Refresh">{item.refresh}</Def>
        {item.workbookLabel ? <Def label="In the old workbook">{item.workbookLabel}</Def> : null}
        <Def label="Specification">{item.specReference}</Def>
      </dl>

      {item.notes ? (
        <details className="mt-2.5 text-[11.5px]">
          <summary className="cursor-pointer text-[var(--text-secondary)]">Why it is defined this way</summary>
          <p className="mt-1.5 leading-relaxed text-[var(--text-muted)]">{item.notes}</p>
        </details>
      ) : null}

      {item.current.value === null && item.current.unavailable ? (
        <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{item.current.unavailable}</p>
      ) : null}

      <a
        href={item.href}
        className="mt-auto inline-flex items-center gap-1 self-start pt-3 text-[11.5px] font-medium"
        style={{ color: 'var(--series-1)' }}
      >
        See it on the dashboard <ArrowUpRight size={12} aria-hidden />
      </a>
    </article>
  );
}

function Badge({ tone, children }: { tone: 'info' | 'neutral'; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium"
      style={{
        background: tone === 'info' ? 'var(--series-1-wash)' : 'var(--surface-2)',
        color: tone === 'info' ? 'var(--series-1)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </span>
  );
}

function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text-secondary)]">{children}</dd>
    </div>
  );
}
