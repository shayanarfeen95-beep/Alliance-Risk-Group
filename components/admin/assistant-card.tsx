'use client';

import { useState } from 'react';
import { CircleCheck, Loader2, Sparkles, TriangleAlert } from 'lucide-react';

/**
 * Which model is answering, and whether it can actually do the job.
 *
 * The check is a button rather than something that runs on load, because it
 * costs a network round trip to OpenRouter — but it is prominent because the
 * failure it catches is silent. A model without tool calling produces fluent
 * answers full of figures that came from nowhere, and nothing in the UI would
 * look wrong.
 */

export interface AssistantCardProps {
  configured: boolean;
  provider: string | null;
  model: string | null;
  detail: string;
  canManage: boolean;
}

interface CheckResult {
  ok: boolean;
  provider?: string;
  model?: string;
  supportsTools?: boolean;
  contextLength?: number | null;
  isFree?: boolean | null;
  detail?: string;
  error?: string;
}

export function AssistantCard(props: AssistantCardProps) {
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);

  async function check() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch('/api/assistant/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(candidate.trim() ? { model: candidate.trim() } : {}),
      });
      setResult((await response.json()) as CheckResult);
    } catch {
      setResult({ ok: false, error: 'The check did not complete.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-[var(--radius-lg)] border p-5"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold">
            <Sparkles size={13} aria-hidden />
            Assistant
          </h3>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
            {props.configured
              ? `${props.provider} · ${props.model}`
              : 'Not configured'}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            background: props.configured ? 'var(--status-good-wash)' : 'var(--surface-2)',
            color: props.configured ? 'var(--status-good)' : 'var(--text-muted)',
          }}
        >
          {props.configured ? 'Configured' : 'Off'}
        </span>
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {props.detail}
      </p>

      {props.canManage && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <label
            className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: 'var(--text-muted)' }}
            htmlFor="model-check"
          >
            Check a model before you rely on it
          </label>
          <div className="flex gap-2">
            <input
              id="model-check"
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              placeholder={props.model ?? 'vendor/model-name:free'}
              className="min-w-0 flex-1 rounded-[5px] border px-2 py-1 text-[11.5px] outline-none"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              type="button"
              onClick={check}
              disabled={busy}
              className="flex shrink-0 items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}
            >
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {busy ? 'Checking…' : 'Check'}
            </button>
          </div>

          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            The model must support <strong>tool calling</strong>. The assistant is nothing but tool
            calls — one without them answers from its own weights, fluently, with figures that came
            from nowhere. Leave the field blank to check what is configured.
          </p>

          {result && (
            <div
              className="mt-3 flex gap-2 rounded-[var(--radius)] border p-2.5"
              style={{
                borderColor: 'var(--border)',
                background: result.ok ? 'var(--status-good-wash)' : 'var(--status-critical-wash)',
              }}
            >
              {result.ok ? (
                <CircleCheck size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--status-good)' }} aria-hidden />
              ) : (
                <TriangleAlert size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--status-critical)' }} aria-hidden />
              )}
              <p
                className="text-[11px] leading-relaxed"
                style={{ color: result.ok ? 'var(--status-good)' : 'var(--status-critical)' }}
              >
                {result.detail ?? result.error}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
