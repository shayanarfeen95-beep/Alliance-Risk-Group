import type { Metadata } from 'next';
import Link from 'next/link';
import { BellRing, CircleAlert } from 'lucide-react';
import { getDb } from '@/lib/db/client';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { monthBounds } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
import {
  AHEAD_OF_PACE,
  BEHIND_PACE,
  CONTRACT_MONTHS,
  FIRST_INVOICE_GRACE_DAYS,
  loadAccountBilling,
  STATUS_LABEL,
} from '@/lib/billing/accounts';
import { LEADERSHIP_SCOPE } from '@/lib/dashboards/leadership-scope';
import { StatTile } from '@/components/dashboard/stat-tile';
import { Card, CardHeader, Unavailable } from '@/components/ui/primitives';
import { AccountBillingTable } from '@/components/billing/account-billing-table';

export const metadata: Metadata = { title: 'Account billing' };
export const dynamic = 'force-dynamic';

/**
 * Account billing — what each won account has billed, against what was booked.
 *
 * Westport: "determine which accounts have started billing in QuickBooks
 * compared to what is closed/won", with "live reporting of progress" against
 * what the account is expected to bill over its first twelve months, and alerts
 * to the account manager when one falls behind.
 */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const context = await loadDashboardContext(params);
  const { session, range } = context;
  const lob = first(params.lob) === 'bc' ? LEADERSHIP_SCOPE.lineOfBusiness : null;

  if (!session.consolidatedAvailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-[19px] font-semibold tracking-tight">Account billing</h1>
        <Unavailable
          reason="NOT_AVAILABLE_BY_DIVISION"
          detail="Billing by customer covers the whole company, so it is shown to people who can see ARG Total."
        />
      </div>
    );
  }

  const db = await getDb();
  const model = await loadAccountBilling(db, session, {
    wonFrom: monthBounds(range.from).start,
    wonTo: monthBounds(range.to).endExclusive,
    lineOfBusiness: lob,
  });

  const lobHref = (value: 'all' | 'bc') => {
    const next = new URLSearchParams();
    for (const [key, raw] of Object.entries(params)) {
      const single = first(raw);
      if (single !== undefined && key !== 'lob') next.set(key, single);
    }
    if (value === 'bc') next.set('lob', 'bc');
    const query = next.toString();
    return `/accounts${query ? `?${query}` : ''}`;
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Account billing</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Every account closed won in HubSpot beside what QuickBooks has billed it since — whether it has started
          billing, and whether it is billing at the pace its deal implies. Live: billing is read as of today, from the
          last QuickBooks pull.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          Deals won in {range.label} · {lob ? `Line of Business: ${lob}` : 'every line of business'} · as of {model.asOf}
        </p>
      </header>

      <div
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-3 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Line of business</span>
        {(
          [
            ['all', 'All'],
            ['bc', LEADERSHIP_SCOPE.lineOfBusiness],
          ] as const
        ).map(([id, label]) => {
          const active = (id === 'bc') === Boolean(lob);
          return (
            <Link
              key={id}
              href={lobHref(id)}
              className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: active ? 'var(--text-primary)' : 'var(--border)',
                background: active ? 'var(--text-primary)' : 'transparent',
                color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
              }}
            >
              {label}
            </Link>
          );
        })}
        <span className="text-[11px] text-[var(--text-muted)]">
          Change which deals are included with the date range at the top of the page.
        </span>
      </div>

      {model.unavailable ? <Unavailable reason="SOURCE_NOT_LOADED" detail={model.unavailable} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Accounts won"
          value={model.totals.accounts}
          detail={`${model.totals.matched} matched to a QuickBooks customer`}
          basis="HubSpot companies with a deal closed won in the range."
        />
        <StatTile
          label="Booked"
          value={model.totals.booked}
          valueFormat="currency"
          basis="The won deals' amounts — taken as what each account is expected to bill over its first 12 months."
        />
        <StatTile
          label="Expected by now"
          value={model.totals.expectedToDate}
          valueFormat="currency"
          basis={`Each deal's amount spread evenly over ${CONTRACT_MONTHS} months from the day it went live, up to today.`}
        />
        <StatTile
          label="Billed since won"
          value={model.totals.billedSinceWon}
          valueFormat="currency"
          detail={`${model.totals.billing} of ${model.totals.accounts} accounts have billed`}
          basis="QuickBooks invoices less credit memos, excluding sales tax, dated on or after the win."
        />
        <StatTile
          label="Need attention"
          value={model.totals.needAttention}
          detail="Not billing, or behind pace"
          basis={`Not billing: live for more than ${FIRST_INVOICE_GRACE_DAYS} days with no invoice. Behind: under ${Math.round(BEHIND_PACE * 100)}% of the amount expected by now.`}
        />
      </div>

      {model.alerts.length > 0 ? (
        <Card>
          <CardHeader
            title="Alerts by account owner"
            subtitle="Accounts that have gone live but are not billing, or are billing behind pace — grouped by the person who owns the deal"
          />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {model.alerts.map((group) => (
              <div
                key={group.owner}
                className="rounded-[var(--radius)] border p-3"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
              >
                <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <BellRing size={13} style={{ color: 'var(--status-warning)' }} aria-hidden />
                  {group.owner}
                  <span className="font-normal text-[var(--text-muted)]">
                    · {group.rows.length} account{group.rows.length === 1 ? '' : 's'}
                  </span>
                </p>
                <ul className="mt-1.5 space-y-1">
                  {group.rows.map((row) => (
                    <li key={row.key} className="text-[11.5px] leading-snug">
                      <span className="font-medium">{row.account}</span>{' '}
                      <span style={{ color: row.status === 'NOT_BILLING' ? 'var(--status-critical)' : 'var(--status-serious)' }}>
                        {STATUS_LABEL[row.status]}
                      </span>
                      <span className="block text-[10.5px] text-[var(--text-muted)]">{row.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            The list updates on every QuickBooks and HubSpot pull. Sending it to each owner by email is the next step
            once an email sender is connected.
          </p>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Booked versus billed, by account"
          subtitle="Click an account for its deals, its billing month by month and how its QuickBooks customer was found"
        />
        <AccountBillingTable rows={model.rows} />
        <div
          className="mt-3 space-y-1 border-t pt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]"
          style={{ borderColor: 'var(--border)' }}
        >
          <p>
            <CircleAlert size={11} className="mr-1 inline" aria-hidden />
            <strong className="text-[var(--text-secondary)]">How the pace is set:</strong> a deal&rsquo;s amount is
            treated as what the account bills in its first {CONTRACT_MONTHS} months, evenly, from the day it went live —
            the day it entered a “Live” stage in HubSpot, or the close date when it has not. On pace is{' '}
            {Math.round(BEHIND_PACE * 100)}%–{Math.round(AHEAD_OF_PACE * 100)}% of the amount expected by now.
          </p>
          <p>
            <strong className="text-[var(--text-secondary)]">How accounts are matched to QuickBooks:</strong> a decision
            in{' '}
            <Link href="/admin?tab=accounts" className="underline underline-offset-2">
              Admin → Account matching
            </Link>{' '}
            first; otherwise the HubSpot company&rsquo;s domain against the customer&rsquo;s website or email, then the
            same name. Matches made by domain or name are counted and labelled so they can be confirmed; weaker
            similarities are only suggested.
          </p>
        </div>
      </Card>
    </div>
  );
}
