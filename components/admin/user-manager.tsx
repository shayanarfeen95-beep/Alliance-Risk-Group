'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, KeyRound, Loader2, ShieldCheck, UserPlus, X } from 'lucide-react';

/**
 * People and access.
 *
 * Roles were always in the system; what was missing was any way to assign them
 * without a database console. The list states each person's scope in words —
 * "All divisions" or the codes they hold — because "DIVISION_MANAGER" alone
 * does not tell an administrator what that person can actually open.
 */

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  canViewConsolidated: boolean;
  divisions: string[];
  isActive: boolean;
  lastLoginAt: string | null;
}

const ROLES = [
  { id: 'ADMIN', label: 'Administrator', hint: 'Everything, including people, mappings and ingestion' },
  { id: 'CFO', label: 'CFO', hint: 'Closes periods, locks forecasts, signs the narrative' },
  { id: 'EXECUTIVE', label: 'Executive', hint: 'Reads everything; changes nothing' },
  { id: 'DIVISION_MANAGER', label: 'Division manager', hint: 'Scoped to their divisions; may lock a forecast' },
  { id: 'VIEWER', label: 'Viewer', hint: 'Read-only, scoped' },
];

export function UserManager({
  users,
  divisions,
  currentUserId,
}: {
  users: ManagedUser[];
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  currentUserId: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(method: 'POST' | 'PATCH', body: unknown, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/users', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'That change could not be applied.');
        return false;
      }
      setNotice(successMessage);
      setAdding(false);
      setEditing(null);
      router.refresh();
      return true;
    } catch {
      setError('The request did not complete.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-[var(--radius)] border p-2.5 text-[11.5px] leading-relaxed"
           style={{ borderColor: 'var(--border)', background: 'var(--status-critical-wash)', color: 'var(--status-critical)' }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-3 flex items-center gap-1.5 text-[11.5px] text-[var(--status-good)]">
          <CircleCheck size={12} aria-hidden />
          {notice}
        </p>
      )}

      <div className="scroll-x -mx-5 px-5">
        <table className="w-full min-w-max border-collapse text-[12px]">
          <thead>
            <tr>
              {['Person', 'Role', 'Sees', 'Status', 'Last signed in', ''].map((h) => (
                <th key={h}
                    className="whitespace-nowrap border-b px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-[11px] text-[var(--text-muted)]">{user.email}</div>
                </td>
                <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                  {ROLES.find((r) => r.id === user.role)?.label ?? user.role}
                </td>
                {/* Scope in words. "DIVISION_MANAGER" does not tell an
                    administrator what this person can actually open. */}
                <td className="border-b px-3 py-2 text-[var(--text-secondary)]" style={{ borderColor: 'var(--border)' }}>
                  {user.canViewConsolidated ? 'All divisions, incl. ARG Total' : user.divisions.join(', ') || '— nothing'}
                </td>
                <td className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{
                          background: user.isActive ? 'var(--status-good-wash)' : 'var(--surface-2)',
                          color: user.isActive ? 'var(--status-good)' : 'var(--text-muted)',
                        }}>
                    {user.isActive ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td className="border-b px-3 py-2 text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                  {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'}
                </td>
                <td className="border-b px-3 py-2 text-right" style={{ borderColor: 'var(--border)' }}>
                  <button type="button" onClick={() => setEditing(editing === user.id ? null : user.id)}
                          className="text-[11px] text-[var(--text-muted)] underline-offset-2 hover:underline">
                    {editing === user.id ? 'Close' : 'Manage'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditPanel
          user={users.find((u) => u.id === editing)!}
          divisions={divisions}
          isSelf={editing === currentUserId}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(patch) => send('PATCH', { userId: editing, ...patch }, 'Access updated.')}
        />
      )}

      <div className="mt-3">
        {adding ? (
          <AddPanel
            divisions={divisions}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={(body) => send('POST', body, 'Person added. Send them their starting password.')}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)}
                  className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                  style={{ borderColor: 'var(--border)' }}>
            <UserPlus size={12} aria-hidden />
            Add a person
          </button>
        )}
      </div>
    </div>
  );
}

function ScopeFields({
  canViewConsolidated,
  setCanViewConsolidated,
  selected,
  setSelected,
  divisions,
}: {
  canViewConsolidated: boolean;
  setCanViewConsolidated: (v: boolean) => void;
  selected: string[];
  setSelected: (v: string[]) => void;
  divisions: Array<{ divisionCode: string; divisionName: string }>;
}) {
  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2 text-[11.5px]">
        <input type="checkbox" checked={canViewConsolidated} className="mt-0.5"
               onChange={(e) => setCanViewConsolidated(e.target.checked)} />
        <span>
          <span className="font-medium">See every division, including ARG Total.</span>{' '}
          <span className="text-[var(--text-muted)]">
            Leave this off to scope someone to specific divisions — they then cannot see the
            consolidated figure either, because it would disclose the divisions they are not entitled to.
          </span>
        </span>
      </label>

      {!canViewConsolidated && (
        <div className="flex flex-wrap gap-1.5 pl-6">
          {divisions.map((division) => {
            const on = selected.includes(division.divisionCode);
            return (
              <button
                key={division.divisionCode}
                type="button"
                onClick={() =>
                  setSelected(
                    on
                      ? selected.filter((d) => d !== division.divisionCode)
                      : [...selected, division.divisionCode],
                  )
                }
                className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  borderColor: on ? 'var(--text-primary)' : 'var(--border)',
                  background: on ? 'var(--surface-2)' : 'transparent',
                  color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {division.divisionName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddPanel({ divisions, busy, onCancel, onSave }: {
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('VIEWER');
  const [canViewConsolidated, setCanViewConsolidated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <div className="rounded-[var(--radius)] border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-[12.5px] font-semibold">Add a person</h4>
        <button type="button" onClick={onCancel} aria-label="Cancel">
          <X size={13} className="text-[var(--text-muted)]" />
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Name" value={name} onChange={setName} />
        <Input label="Email" value={email} onChange={setEmail} type="email" />
        <Input label="Starting password" value={password} onChange={setPassword} type="password"
               hint="At least 12 characters. Share it with them directly; they can change it later." />
        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}
                  className="w-full rounded-[5px] border px-2 py-1.5 text-[11.5px] outline-none"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <span className="mt-1 block text-[10.5px] text-[var(--text-muted)]">
            {ROLES.find((r) => r.id === role)?.hint}
          </span>
        </label>
      </div>

      <div className="mt-3">
        <ScopeFields canViewConsolidated={canViewConsolidated} setCanViewConsolidated={setCanViewConsolidated}
                     selected={selected} setSelected={setSelected} divisions={divisions} />
      </div>

      <button type="button" disabled={busy}
              onClick={() => onSave({ name, email, password, role, canViewConsolidated, divisions: selected })}
              className="mt-3 flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}>
        {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <UserPlus size={12} aria-hidden />}
        Add person
      </button>
    </div>
  );
}

function EditPanel({ user, divisions, isSelf, busy, onCancel, onSave }: {
  user: ManagedUser;
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  isSelf: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [role, setRole] = useState(user.role);
  const [canViewConsolidated, setCanViewConsolidated] = useState(user.canViewConsolidated);
  const [selected, setSelected] = useState<string[]>(user.divisions);
  const [password, setPassword] = useState('');

  return (
    <div className="mt-3 rounded-[var(--radius)] border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-[12.5px] font-semibold">{user.name}</h4>
        <button type="button" onClick={onCancel} aria-label="Close">
          <X size={13} className="text-[var(--text-muted)]" />
        </button>
      </div>

      {isSelf && (
        <p className="mb-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden />
          This is your own account. You cannot remove your own administrator access — there would be
          no way back in.
        </p>
      )}

      <label className="block max-w-xs">
        <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}
                className="w-full rounded-[5px] border px-2 py-1.5 text-[11.5px] outline-none disabled:opacity-50"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>

      <div className="mt-3">
        <ScopeFields canViewConsolidated={canViewConsolidated} setCanViewConsolidated={setCanViewConsolidated}
                     selected={selected} setSelected={setSelected} divisions={divisions} />
      </div>

      <div className="mt-3 max-w-xs">
        <Input label="Reset password (optional)" value={password} onChange={setPassword} type="password"
               hint="Leave blank to keep the current one." />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy}
                onClick={() => onSave({ role, canViewConsolidated, divisions: selected, ...(password ? { password } : {}) })}
                className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                style={{ borderColor: 'var(--border)' }}>
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <KeyRound size={12} aria-hidden />}
          Save changes
        </button>

        {!isSelf && (
          <button type="button" disabled={busy}
                  onClick={() => onSave({ isActive: !user.isActive })}
                  className="rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: user.isActive ? 'var(--status-critical)' : 'var(--text-primary)' }}>
            {user.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        )}
      </div>
    </div>
  );
}

function Input({ label, value, onChange, type = 'text', hint }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
             className="w-full rounded-[5px] border px-2 py-1.5 text-[11.5px] outline-none"
             style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }} />
      {hint && <span className="mt-1 block text-[10.5px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}
