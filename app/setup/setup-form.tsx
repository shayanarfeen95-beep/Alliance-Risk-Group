'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export function SetupForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadDemoData, setLoadDemoData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password, loadDemoData }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'Setup could not complete.');
        return;
      }
      router.push('/executive');
      router.refresh();
    } catch {
      setError('Setup could not complete — the request did not finish.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Your name" value={name} onChange={setName} autoComplete="name" />
      <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="username" />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters."
      />

      <label
        className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <input
          type="checkbox"
          checked={loadDemoData}
          onChange={(e) => setLoadDemoData(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-[11.5px] leading-relaxed">
          <span className="font-medium">Load the demonstration dataset.</span>{' '}
          <span className="text-[var(--text-secondary)]">
            Three years of figures reproducing the build specification&rsquo;s published numbers, so
            every dashboard is populated before QuickBooks is connected. Leave this off for a
            deployment that will hold ARG&rsquo;s real books — the warehouse then starts empty and
            fills from the connectors.
          </span>
        </span>
      </label>

      {error && (
        <p className="text-[11.5px] leading-relaxed text-[var(--status-critical)]">{error}</p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px] font-medium disabled:opacity-60"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
        {busy ? 'Setting up…' : 'Create administrator'}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-[var(--text-secondary)]">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded-[5px] border px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-strong)]"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
      />
      {hint && <span className="mt-1 block text-[10.5px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}
