/**
 * The building blocks of the Admin page: status cards, the tab bar, and the
 * plain-English names for things the database stores as codes.
 *
 * Admin is where somebody goes when something is wrong or needs setting up. It
 * should answer "is everything all right, and if not what do I do" before it
 * shows a single table — so the overview leads, and every code a reader would
 * otherwise have to decode (PL_TIES_TO_TRIAL_BALANCE, SOURCE_CONNECTED,
 * BALANCE_SHEET_CLASSED) is shown under the name a person would use.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';

export type StatusTone = 'good' | 'warning' | 'critical' | 'neutral';

const TONE: Record<StatusTone, { color: string; wash: string }> = {
  good: { color: 'var(--status-good)', wash: 'var(--status-good-wash)' },
  warning: { color: 'var(--status-warning)', wash: 'var(--status-warning-wash)' },
  critical: { color: 'var(--status-critical)', wash: 'var(--status-critical-wash)' },
  neutral: { color: 'var(--text-muted)', wash: 'var(--surface-2)' },
};

export function StatusIcon({ tone, size = 14 }: { tone: StatusTone; size?: number }) {
  const color = TONE[tone].color;
  if (tone === 'good') return <CircleCheck size={size} style={{ color }} aria-hidden />;
  if (tone === 'critical') return <CircleAlert size={size} style={{ color }} aria-hidden />;
  return <TriangleAlert size={size} style={{ color }} aria-hidden />;
}

/** One headline status — a label, a big value, one line of context, and where to go. */
export function StatusCard({
  label,
  value,
  context,
  tone,
  href,
  action,
}: {
  label: string;
  value: string;
  context: string;
  tone: StatusTone;
  href: string;
  action: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-[var(--radius-lg)] border p-4 transition-shadow hover:shadow-[var(--shadow-raised)]"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</p>
        <span className="rounded-full p-1" style={{ background: TONE[tone].wash }}>
          <StatusIcon tone={tone} size={13} />
        </span>
      </div>
      <p className="mt-2 text-[22px] font-semibold leading-none tracking-tight">{value}</p>
      <p className="mt-2 text-[11.5px] leading-snug text-[var(--text-secondary)]">{context}</p>
      <span className="mt-auto inline-flex items-center gap-1 pt-3 text-[11.5px] font-medium" style={{ color: 'var(--series-1)' }}>
        {action}
        <ArrowRight size={12} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export interface AdminTab {
  id: string;
  label: string;
  /** A count or short status shown on the tab, e.g. "2" failing or "2/3". */
  badge?: string;
  badgeTone?: StatusTone;
}

/** Tabs as links, so the tab is in the URL: refresh keeps it and it can be shared. */
export function AdminTabBar({ tabs, active }: { tabs: AdminTab[]; active: string }) {
  return (
    <nav
      aria-label="Admin sections"
      className="-mx-1 flex gap-1 overflow-x-auto rounded-[var(--radius-lg)] border p-1"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={`/admin?tab=${tab.id}`}
            aria-current={isActive ? 'page' : undefined}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: isActive ? 'var(--text-primary)' : 'transparent',
              color: isActive ? 'var(--text-inverse)' : 'var(--text-secondary)',
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span
                className="rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
                style={{
                  background: isActive ? 'color-mix(in srgb, var(--text-inverse) 20%, transparent)' : TONE[tab.badgeTone ?? 'neutral'].wash,
                  color: isActive ? 'var(--text-inverse)' : TONE[tab.badgeTone ?? 'neutral'].color,
                }}
              >
                {tab.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** A to-do item on the overview: what is wrong, why it matters, and the one place to fix it. */
export function AttentionItem({
  tone,
  title,
  detail,
  href,
  action,
}: {
  tone: StatusTone;
  title: string;
  detail: ReactNode;
  href: string;
  action: string;
}) {
  return (
    <li className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <span className="mt-0.5 shrink-0">
        <StatusIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{detail}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded-[var(--radius)] border px-2.5 py-1 text-[11.5px] font-medium hover:bg-[var(--surface-2)]"
        style={{ borderColor: 'var(--border-strong)' }}
      >
        {action}
      </Link>
    </li>
  );
}

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ background: TONE[tone].wash, color: TONE[tone].color }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Plain-English names
// ---------------------------------------------------------------------------

export const CHECK_NAMES: Record<string, { name: string; means: string }> = {
  PL_TIES_TO_QUICKBOOKS: {
    name: 'P&L ties to QuickBooks',
    means: 'ARG Total revenue, COGS and operating expenses equal QuickBooks’ own company total.',
  },
  PL_TIES_TO_TRIAL_BALANCE: {
    name: 'P&L ties to its accounts',
    means: 'Each division’s five P&L lines equal the accounts they were rolled up from.',
  },
  DIVISION_SUMS_TIE_TO_TOTAL: {
    name: 'Every division present',
    means: 'All four divisions reported for each month, and no row belongs to an unknown division.',
  },
  BALANCE_SHEET_BALANCES: {
    name: 'Balance sheet balances',
    means: 'Total assets equal total liabilities plus equity, with equity loaded from QuickBooks.',
  },
  TRIAL_BALANCE_BALANCES: {
    name: 'Trial balance balances',
    means: 'QuickBooks’ trial balance for the month has equal debits and credits.',
  },
  AGING_TIES_TO_BALANCE_SHEET: {
    name: 'Aging ties to the balance sheet',
    means: 'Open invoices and bills add up to A/R and A/P on the balance sheet.',
  },
  NO_UNMAPPED_RECORDS: {
    name: 'Nothing unmapped',
    means: 'Every QuickBooks class and account is assigned, so no money is left out.',
  },
};

export const SETTING_NAMES: Record<string, string> = {
  DATA_MODE: 'Which data the dashboards show',
  BALANCE_SHEET_CLASSED: 'Balance sheet split by division in QuickBooks',
  HUBSPOT_DIVISION_ATTRIBUTION: 'How a HubSpot deal is assigned to a division',
  CLAIMS_SYSTEM_OF_RECORD: 'Claims operational system',
  MARKETING_SPEND_ACCOUNTS: 'Accounts that count as marketing spend',
  SALES_AND_MARKETING_SPEND_ACCOUNTS: 'Accounts that count as sales and marketing spend',
  ACCOUNTING_BASIS: 'Accounting basis',
  DEFAULT_REPORTING_MONTH: 'Pinned reporting month (optional)',
};

export const AUDIT_NAMES: Record<string, string> = {
  AUDIT_PACK_EXPORTED: 'Audit pack downloaded',
  COMMENTARY_DRAFTED: 'Monthly summary drafted',
  DEPLOYMENT_INITIALISED: 'System set up',
  FINANCE_EXPORTED: 'Finance CSV downloaded',
  FORECAST_LOCKED: 'Forecast locked',
  FORECAST_LOCK_WAIVED: 'Forecast lock waived',
  FORECAST_SCENARIO_SAVED: 'Forecast scenario saved',
  LOGIN: 'Signed in',
  SOURCE_CONNECTED: 'Source connected',
  SOURCE_DISCONNECTED: 'Source disconnected',
  USER_CREATED: 'Person added',
  USER_UPDATED: 'Person’s access changed',
  VIEW_DELETED: 'View deleted',
};

export const ENTITY_NAMES: Record<string, string> = {
  profit_and_loss: 'Profit & loss',
  balance_sheet: 'Balance sheet',
  trial_balance: 'Trial balance',
  budgets: 'Budgets',
  ar_aging: 'A/R aging',
  ap_aging: 'A/P aging',
  accounts: 'Chart of accounts',
  classes: 'Class list',
  deals: 'Deals',
  contacts: 'Contacts',
  companies: 'Companies',
  meetings: 'Meetings',
  owners: 'Salespeople',
  deal_stages: 'Deal stages',
  monthly_budget: 'Budget (Sheets)',
  tenx_budget: '10X plan',
  forecast: 'Forecast',
  headcount: 'Headcount',
};

export const SOURCE_NAMES: Record<string, string> = {
  QBO: 'QuickBooks',
  HUBSPOT: 'HubSpot',
  SHEETS: 'Google Sheets',
  SEED: 'Seed',
  UPLOAD: 'Upload',
  MANUAL: 'Manual',
};

/** "3 hours ago", "2 days ago" — for freshness, where the age is the point. */
export function ago(date: Date | null, now: Date = new Date()): string {
  if (!date) return 'never';
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
