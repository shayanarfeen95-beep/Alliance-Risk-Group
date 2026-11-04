'use client';

/**
 * Which QuickBooks customer each won HubSpot account is.
 *
 * The dashboard suggests a match — by a shared domain, then by the same name —
 * and counts it, labelled. This is where Westport confirms it, picks another
 * customer, or says the account has no QuickBooks customer. A decision here
 * always wins over a suggestion, and is kept in the audit of who decided.
 */
import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Card, CardHeader } from '@/components/ui/primitives';
import { decideAccountMatchAction } from '@/app/(app)/admin/account-actions';
import { formatNumber } from '@/lib/format';
import type { AccountBillingRow, CustomerOption } from '@/lib/billing/accounts';

const METHOD: Record<AccountBillingRow['match']['method'], { label: string; tone: string }> = {
  CONFIRMED: { label: 'Confirmed', tone: 'var(--status-good)' },
  DOMAIN: { label: 'Suggested — same domain', tone: 'var(--status-serious)' },
  NAME: { label: 'Suggested — same name', tone: 'var(--status-serious)' },
  NONE: { label: 'No match found', tone: 'var(--status-critical)' },
  REJECTED: { label: 'No QuickBooks customer', tone: 'var(--text-secondary)' },
};

export function AccountMatching({
  rows,
  customers,
  canEdit,
}: {
  rows: AccountBillingRow[];
  customers: CustomerOption[];
  canEdit: boolean;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const accounts = rows.filter((row) => row.companyId);
  const open = accounts.filter((row) => row.match.method !== 'CONFIRMED' && row.match.method !== 'REJECTED');
  const shown = filter === 'open' ? open : accounts;

  return (
    <Card>
      <CardHeader
        title="Account matching"
        subtitle="Which QuickBooks customer each account won in HubSpot is billed as"
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            ['open', `To review · ${open.length}`],
            ['all', `All accounts · ${accounts.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
            className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
            style={{
              borderColor: filter === id ? 'var(--text-primary)' : 'var(--border)',
              background: filter === id ? 'var(--text-primary)' : 'transparent',
              color: filter === id ? 'var(--text-inverse)' : 'var(--text-secondary)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <datalist id="qbo-customers">
        {customers.map((customer) => (
          <option key={customer.id} value={customer.name} />
        ))}
      </datalist>

      <div className="scroll-x">
        <table className="w-full min-w-[880px] border-collapse text-[12px]">
          <thead>
            <tr>
              {['Account (HubSpot)', 'Booked', 'Owner', 'Match', 'QuickBooks customer'].map((heading) => (
                <th
                  key={heading}
                  className="border-b px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <MatchRow key={row.key} row={row} customers={customers} canEdit={canEdit} />
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">Every account has a decision.</p>
        ) : null}
      </div>
    </Card>
  );
}

function MatchRow({ row, customers, canEdit }: { row: AccountBillingRow; customers: CustomerOption[]; canEdit: boolean }) {
  const [state, action] = useActionState(decideAccountMatchAction, null);
  const [typed, setTyped] = useState('');
  const byName = useMemo(() => new Map(customers.map((customer) => [customer.name.toLowerCase(), customer.id])), [customers]);
  const typedId = byName.get(typed.trim().toLowerCase()) ?? '';
  const method = METHOD[row.match.method];
  const td = 'border-b px-2.5 py-2 align-top';

  return (
    <tr>
      <td className={td} style={{ borderColor: 'var(--border)' }}>
        <span className="font-medium">{row.account}</span>
        <span className="block text-[10.5px] text-[var(--text-muted)]">won {row.wonOn}</span>
      </td>
      <td className={`${td} tnum`} style={{ borderColor: 'var(--border)' }}>{formatNumber(row.booked, 'currency')}</td>
      <td className={td} style={{ borderColor: 'var(--border)' }}>{row.owners.join(', ')}</td>
      <td className={td} style={{ borderColor: 'var(--border)' }}>
        <span className="text-[11px] font-medium" style={{ color: method.tone }}>{method.label}</span>
        {row.match.customerName ? <span className="block text-[11px]">{row.match.customerName}</span> : null}
        {row.match.suggestions.length ? (
          <span className="block text-[10.5px] text-[var(--text-muted)]">
            Possible: {row.match.suggestions.map((s) => s.name).join(' · ')}
          </span>
        ) : null}
      </td>
      <td className={td} style={{ borderColor: 'var(--border)' }}>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {row.match.customerId && row.match.method !== 'CONFIRMED' ? (
              <form action={action}>
                <input type="hidden" name="companyId" value={row.companyId ?? ''} />
                <input type="hidden" name="customerId" value={row.match.customerId} />
                <Submit label="Confirm" />
              </form>
            ) : null}
            {row.match.suggestions.map((suggestion) => (
              <form key={suggestion.id} action={action}>
                <input type="hidden" name="companyId" value={row.companyId ?? ''} />
                <input type="hidden" name="customerId" value={suggestion.id} />
                <Submit label={`Use ${suggestion.name}`} subtle />
              </form>
            ))}
            <form action={action} className="flex items-center gap-1">
              <input type="hidden" name="companyId" value={row.companyId ?? ''} />
              <input type="hidden" name="customerId" value={typedId} />
              <input
                list="qbo-customers"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Type a QuickBooks customer"
                className="w-48 rounded-[4px] border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
              />
              <Submit label="Save" disabled={!typedId} />
            </form>
            <form action={action}>
              <input type="hidden" name="companyId" value={row.companyId ?? ''} />
              <input type="hidden" name="customerId" value="__none__" />
              <Submit label="No QuickBooks customer" subtle />
            </form>
            {row.match.method === 'CONFIRMED' || row.match.method === 'REJECTED' ? (
              <form action={action}>
                <input type="hidden" name="companyId" value={row.companyId ?? ''} />
                <input type="hidden" name="customerId" value="__auto__" />
                <Submit label="Automatic" subtle />
              </form>
            ) : null}
          </div>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">Only an administrator or the CFO can change matches.</span>
        )}
        {state?.error ? <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-critical)' }}>{state.error}</p> : null}
        {state?.ok ? <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-good)' }}>{state.ok}</p> : null}
      </td>
    </tr>
  );
}

function Submit({ label, subtle, disabled }: { label: string; subtle?: boolean; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-[4px] border px-1.5 py-0.5 text-[10.5px] font-medium disabled:opacity-40"
      style={{
        borderColor: subtle ? 'var(--border)' : 'var(--text-primary)',
        background: subtle ? 'transparent' : 'var(--text-primary)',
        color: subtle ? 'var(--text-secondary)' : 'var(--text-inverse)',
      }}
    >
      {pending ? 'Saving…' : label}
    </button>
  );
}
