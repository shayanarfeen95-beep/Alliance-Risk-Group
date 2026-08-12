'use client';

import { useActionState } from 'react';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { login, type LoginState } from './actions';

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} className="space-y-4">
      <Field label="Email" name="email" type="email" autoComplete="username" autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" />

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2.5 text-[13px]"
          style={{ background: 'var(--status-critical-wash)', color: 'var(--delta-bad)' }}
        >
          <AlertCircle size={15} className="mt-px shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius)] text-[13px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        {pending ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : null}
        {pending ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  autoFocus,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        className="h-10 w-full rounded-[var(--radius)] border px-3 text-[13px] outline-none transition-colors"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
      />
    </div>
  );
}
