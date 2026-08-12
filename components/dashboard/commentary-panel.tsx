'use client';

import { useState } from 'react';
import { FileText, Loader2, PenLine, ShieldCheck } from 'lucide-react';

/**
 * The monthly narrative, and the control that drafts it.
 *
 * The provenance line is not decoration. A reader needs to know whether they are
 * looking at prose a model wrote or the system's own draft, and — when a model
 * draft was thrown away — why. A narrative about money that hides where its
 * sentences came from is worth less than one that admits it.
 */
export function CommentaryPanel({
  month,
  initial,
  canDraft,
}: {
  month: string;
  initial: { draft: string; signedAt: string | null } | null;
  canDraft: boolean;
}) {
  const [body, setBody] = useState(initial?.draft ?? null);
  const [signedAt] = useState(initial?.signedAt ?? null);
  const [provenance, setProvenance] = useState<{ modelWritten: boolean; rejectionReason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/commentary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ month: month.slice(0, 7) }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'The narrative could not be drafted.');
        return;
      }
      setBody(payload.commentary.body);
      setProvenance({
        modelWritten: payload.commentary.modelWritten,
        rejectionReason: payload.commentary.rejectionReason,
      });
    } catch {
      setError('The narrative could not be drafted — the request did not complete.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {body ? (
        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{body}</p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
          No narrative has been drafted for this month. The draft reads the account-level detail, so
          it names the accounts that drove a movement rather than only reporting that one occurred.
        </p>
      )}

      <div
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-[11px] text-[var(--text-muted)]"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="flex items-center gap-1.5">
          {signedAt ? (
            <>
              <ShieldCheck size={12} aria-hidden />
              Signed {new Date(signedAt).toLocaleDateString()}
            </>
          ) : (
            <>
              <PenLine size={12} aria-hidden />
              {body ? 'Draft — not yet signed by Westport.' : 'Not drafted.'}
            </>
          )}
        </span>

        {provenance && (
          <span className="flex items-center gap-1.5">
            <FileText size={12} aria-hidden />
            {provenance.modelWritten
              ? 'Written by the assistant from resolved figures, and verified against them.'
              : 'Written by the system from resolved figures.'}
          </span>
        )}

        {canDraft && (
          <button
            type="button"
            onClick={draft}
            disabled={busy}
            className="ml-auto flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
            style={{ borderColor: 'var(--border)' }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <PenLine size={12} aria-hidden />}
            {busy ? 'Drafting…' : body ? 'Redraft' : 'Draft the narrative'}
          </button>
        )}
      </div>

      {/* A rejected model draft is reported rather than hidden: the figures are
          unaffected, and knowing the model was overruled is the useful part. */}
      {provenance?.rejectionReason && (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--status-warning)]">
          {provenance.rejectionReason}
        </p>
      )}

      {error && (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--status-critical)]">{error}</p>
      )}
    </div>
  );
}
