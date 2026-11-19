import Link from 'next/link';

/**
 * Line of Business, named exactly as HubSpot names it.
 *
 * Westport, November 2026: "Ideally we should keep same naming conventions that
 * we are using in Quickbooks and also Hubspot … Would like to be able to pull
 * Account Billing info by each division as well as hubspot data (pipeline)."
 * The options are the values on the deals themselves, so a label here is the
 * label in HubSpot; QuickBooks divisions keep their class names in the division
 * selector at the top.
 */
export function LineOfBusinessPicker({
  path,
  params,
  options,
  selected,
  allLabel = 'All lines of business',
  note,
}: {
  path: string;
  params: Record<string, string | string[] | undefined>;
  options: Array<{ label: string; deals: number }>;
  /** The selected label, or null for all. */
  selected: string | null;
  allLabel?: string;
  note?: string;
}) {
  const href = (value: string) => {
    const next = new URLSearchParams();
    for (const [key, raw] of Object.entries(params)) {
      const single = Array.isArray(raw) ? raw[0] : raw;
      if (single !== undefined && key !== 'lob') next.set(key, single);
    }
    next.set('lob', value);
    return `${path}?${next.toString()}`;
  };
  const chip = (value: string, label: string, active: boolean, count?: number) => (
    <Link
      key={value}
      href={href(value)}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className="rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors"
      style={{
        borderColor: active ? 'var(--text-primary)' : 'var(--border)',
        background: active ? 'var(--text-primary)' : 'var(--surface-1)',
        color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
      }}
    >
      {label}
      {count !== undefined ? <span className="ml-1 opacity-60">{count}</span> : null}
    </Link>
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius)] border px-3 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <span className="mr-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
        Line of Business <span className="font-normal text-[var(--text-muted)]">(HubSpot)</span>
      </span>
      {chip('all', allLabel, selected === null)}
      {options.map((option) => chip(option.label, option.label, selected === option.label, option.deals))}
      {note ? <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">{note}</span> : null}
    </div>
  );
}
