'use client';

/**
 * Lent access, on one screen.
 *
 * The list comes before the form on purpose. The question an administrator
 * opens this for is almost never "who should I grant something to" — it is
 * "what is currently loose", and that has to be answerable without clicking
 * anything.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Clock, LoaderCircle, ShieldCheck, TriangleAlert, X } from 'lucide-react';

export interface ActiveGrant {
  id: string;
  userName: string;
  capability: string;
  divisionCode: string | null;
  reason: string;
  grantedByName: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface AccessDelegationProps {
  grants: ActiveGrant[];
  people: Array<{ id: string; name: string; email: string; isSuperAdmin: boolean }>;
  capabilities: string[];
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  canDelegate: boolean;
}

const CAPABILITY_LABELS: Record<string, string> = {
  RUN_INGESTION: 'Pull data from sources',
  CLOSE_PERIOD: 'Close a period',
  LOCK_FORECAST: 'Lock a forecast',
  WAIVE_FORECAST_LOCK: 'Waive a forecast lock',
  EDIT_MAPPINGS: 'Change mappings and connections',
  MANAGE_USERS: 'Manage people and access',
  SIGN_COMMENTARY: 'Sign the monthly narrative',
};

function label(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability.replace(/_/g, ' ').toLowerCase();
}

function whenText(expiresAt: string | null): string {
  if (!expiresAt) return 'until revoked';
  const date = new Date(expiresAt);
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  return `until ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}${days <= 7 ? ` · ${days} day${days === 1 ? '' : 's'} left` : ''}`;
}

export function AccessDelegation(props: AccessDelegationProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    userId: '',
    capability: props.capabilities[0] ?? '',
    divisionCode: '',
    reason: '',
    expiresAt: '',
  });

  async function send(method: 'POST' | 'PATCH', body: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/access', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as
        | { ok: true; message: string }
        | { ok: false; error: string };

      if (!payload.ok) setError(payload.error);
      else {
        setNotice(payload.message);
        setForm((current) => ({ ...current, reason: '', expiresAt: '' }));
        router.refresh();
      }
    } catch {
      setError('The request did not complete. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {props.grants.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Nothing is currently lent. Everyone can do exactly what their role allows.
        </p>
      ) : (
        <ul className="space-y-2">
          {props.grants.map((grant) => {
            const endingSoon =
              grant.expiresAt !== null &&
              new Date(grant.expiresAt).getTime() - Date.now() < 7 * 86_400_000;

            return (
              <li
                key={grant.id}
                className="flex items-start justify-between gap-3 rounded-[var(--radius)] border p-3"
                style={{
                  borderColor: grant.expiresAt === null ? 'var(--status-warning)' : 'var(--border)',
                  background: 'var(--surface-1)',
                }}
              >
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium">
                    {grant.userName} — {label(grant.capability)}
                    {grant.divisionCode ? ` · ${grant.divisionCode}` : ''}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-muted)]">
                    <span className="inline-flex items-center gap-1">
                      {grant.expiresAt === null ? (
                        <TriangleAlert size={11} style={{ color: 'var(--status-warning)' }} aria-hidden />
                      ) : (
                        <Clock size={11} aria-hidden />
                      )}
                      {whenText(grant.expiresAt)}
                    </span>
                    <span>· granted by {grant.grantedByName}</span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    “{grant.reason}”
                  </p>
                  {endingSoon ? null : null}
                </div>

                {props.canDelegate ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => send('PATCH', { grantId: grant.id })}
                    className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                  >
                    <X size={11} aria-hidden />
                    Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {props.canDelegate ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send('POST', {
              userId: form.userId,
              capability: form.capability,
              divisionCode: form.divisionCode || null,
              reason: form.reason,
              expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59Z`).toISOString() : null,
            });
          }}
          className="rounded-[var(--radius)] border p-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium">
            <ShieldCheck size={13} aria-hidden style={{ color: 'var(--series-1)' }} />
            Lend a capability
          </p>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="To">
              <select
                required
                value={form.userId}
                onChange={(event) => setForm((f) => ({ ...f, userId: event.target.value }))}
                className="h-8 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
              >
                <option value="">Choose a person…</option>
                {props.people
                  .filter((person) => !person.isSuperAdmin)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Capability">
              <select
                value={form.capability}
                onChange={(event) => setForm((f) => ({ ...f, capability: event.target.value }))}
                className="h-8 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
              >
                {props.capabilities.map((capability) => (
                  <option key={capability} value={capability}>
                    {label(capability)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Division (optional)">
              <select
                value={form.divisionCode}
                onChange={(event) => setForm((f) => ({ ...f, divisionCode: event.target.value }))}
                className="h-8 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
              >
                <option value="">All divisions</option>
                {props.divisions.map((division) => (
                  <option key={division.divisionCode} value={division.divisionCode}>
                    {division.divisionName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Until">
              <input
                type="date"
                value={form.expiresAt}
                onChange={(event) => setForm((f) => ({ ...f, expiresAt: event.target.value }))}
                className="h-8 w-full rounded-[5px] border px-1.5 text-[11.5px] outline-none"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
              />
            </Field>
          </div>

          <div className="mt-2">
            <Field label="Reason">
              <input
                required
                value={form.reason}
                onChange={(event) => setForm((f) => ({ ...f, reason: event.target.value }))}
                placeholder="Covering the March close while Ryan is away"
                className="h-8 w-full rounded-[5px] border px-2 text-[11.5px] outline-none"
                style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
              />
            </Field>
          </div>

          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            Leaving the end date empty grants it until somebody revokes it — allowed, and listed
            above with a warning, because a permission nobody has to renew is one nobody reviews.
          </p>

          <button
            type="submit"
            disabled={busy || !form.userId || !form.reason.trim()}
            className="mt-2 inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : null}
            Grant
          </button>
        </form>
      ) : (
        <p className="text-[11px] text-[var(--text-muted)]">
          Only a super administrator can lend access. Delegating is deliberately not itself
          delegable — a lent permission cannot be used to lend more.
        </p>
      )}

      {notice ? (
        <p className="flex items-start gap-2 text-[11.5px]" style={{ color: 'var(--status-good)' }}>
          <CircleCheck size={13} className="mt-px shrink-0" aria-hidden />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-[11.5px]" style={{ color: 'var(--delta-bad)' }}>
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
        {text}
      </span>
      {children}
    </label>
  );
}
