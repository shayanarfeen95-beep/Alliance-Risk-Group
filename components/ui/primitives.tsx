import type { ReactNode } from 'react';
import { AlertTriangle, CircleAlert, CircleCheck, Info, Lock, LockOpen } from 'lucide-react';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-[var(--radius-lg)] border ${padded ? 'p-5' : ''} ${className}`}
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-[var(--text-secondary)]">
        {children}
      </h2>
      {hint ? <span className="text-[11px] text-[var(--text-muted)]">{hint}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';

const TONE_STYLE: Record<Tone, { color: string; background: string }> = {
  good: { color: 'var(--status-good)', background: 'var(--status-good-wash)' },
  warning: { color: 'var(--status-warning)', background: 'var(--status-warning-wash)' },
  serious: { color: 'var(--status-serious)', background: 'var(--status-warning-wash)' },
  critical: { color: 'var(--status-critical)', background: 'var(--status-critical-wash)' },
  neutral: { color: 'var(--text-secondary)', background: 'var(--surface-2)' },
  info: { color: 'var(--text-secondary)', background: 'var(--surface-2)' },
};

/**
 * A status chip always carries an icon and a label.
 *
 * Status colour never carries meaning alone — warning and serious sit below 3:1
 * against the light surface by design, and the icon-plus-label pairing is the
 * mitigation.
 */
export function Chip({
  tone = 'neutral',
  icon,
  children,
  title,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const style = TONE_STYLE[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ color: style.color, background: style.background }}
    >
      {icon}
      {children}
    </span>
  );
}

export function ReconChip({ failed, total }: { failed: number; total: number }) {
  if (failed === 0) {
    return (
      <Chip
        tone="good"
        icon={<CircleCheck size={13} aria-hidden />}
        title={`All ${total} reconciliation checks pass.`}
      >
        {total} checks pass
      </Chip>
    );
  }
  return (
    <Chip
      tone="critical"
      icon={<CircleAlert size={13} aria-hidden />}
      title="A reconciliation check is failing. Figures on this page may not tie to source."
    >
      {failed} check{failed === 1 ? '' : 's'} failing
    </Chip>
  );
}

/**
 * §5.3: "Every view must display the timestamp of the last successful refresh
 * and whether the displayed month is open or closed. A stale dashboard that
 * looks live is worse than no dashboard."
 */
export function PeriodChip({ isClosed }: { isClosed: boolean }) {
  return isClosed ? (
    <Chip tone="neutral" icon={<Lock size={12} aria-hidden />} title="Books are closed for this month.">
      Closed period
    </Chip>
  ) : (
    <Chip
      tone="warning"
      icon={<LockOpen size={12} aria-hidden />}
      title="Books are not closed. Figures are preliminary and will change."
    >
      Open period — preliminary
    </Chip>
  );
}

// ---------------------------------------------------------------------------
// Empty and unavailable states
// ---------------------------------------------------------------------------

/**
 * Rendered wherever a figure could not be produced.
 *
 * Deliberately not a zero and not a blank cell: §11 requires the reason to be
 * stated, and Defect 1 exists because a missing figure read as $0.
 */
export function Unavailable({ reason, detail }: { reason: string; detail: string }) {
  const tone: Tone = reason === 'PENDING_DEFINITION' ? 'warning' : 'neutral';
  return (
    <div
      className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2.5 text-[11px] leading-relaxed"
      style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
    >
      {tone === 'warning' ? (
        <AlertTriangle size={13} className="mt-px shrink-0" style={{ color: 'var(--status-warning)' }} aria-hidden />
      ) : (
        <Info size={13} className="mt-px shrink-0" aria-hidden />
      )}
      <span>{detail}</span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="max-w-md text-[12px] leading-relaxed text-[var(--text-muted)]">{detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function DataTable({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`scroll-x -mx-5 px-5 ${className}`}>
      <table className="w-full min-w-max border-collapse text-[12px]">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'right',
  className = '',
  title,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
}) {
  return (
    <th
      title={title}
      className={`whitespace-nowrap border-b px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${className}`}
      style={{
        textAlign: align,
        borderColor: 'var(--border)',
        color: 'var(--text-muted)',
      }}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'right',
  numeric = true,
  muted = false,
  className = '',
  style,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  numeric?: boolean;
  muted?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={`whitespace-nowrap border-b px-3 py-1.5 ${numeric ? 'tnum' : ''} ${className}`}
      style={{
        textAlign: align,
        borderColor: 'var(--border)',
        color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        ...style,
      }}
    >
      {children}
    </td>
  );
}
