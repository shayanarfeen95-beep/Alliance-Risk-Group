'use client';

import { useActionState, useState } from 'react';
import { Lock, LoaderCircle } from 'lucide-react';
import { lockScenarioAction, type ForecastActionState } from '@/app/(app)/forecast/actions';

/**
 * §10.3 — one action locks the forecast.
 *
 * When a locked forecast already exists for the month, locking a second one is a
 * correction: it creates a new version, supersedes the old one, and requires a
 * reason that goes on the record. Both versions stay visible afterwards.
 */
export function LockControls({
  versionId,
  requiresReason,
}: {
  versionId: string;
  requiresReason: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<ForecastActionState, FormData>(
    lockScenarioAction,
    {},
  );

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 text-[11.5px] font-medium"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
      >
        <Lock size={12} aria-hidden />
        Lock as official
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="versionId" value={versionId} />
      {requiresReason ? (
        <input
          name="correctionReason"
          required
          placeholder="Reason for correcting the locked forecast"
          className="h-7 w-64 rounded-[var(--radius-sm)] border px-2 text-[11.5px] outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
        />
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[11.5px] font-medium disabled:opacity-50"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        {pending ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Lock size={12} aria-hidden />}
        Confirm lock
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-[11.5px] text-[var(--text-muted)] underline-offset-2 hover:underline"
      >
        Cancel
      </button>
      {state.error ? (
        <span className="w-full text-right text-[11px]" style={{ color: 'var(--delta-bad)' }}>
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
