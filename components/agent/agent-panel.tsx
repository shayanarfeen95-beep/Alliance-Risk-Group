'use client';

/**
 * The agent, present on every page.
 *
 * It reads the current month, division and dashboard from the URL, so a request
 * like "why did Claims lose money?" never has to restate the context the user is
 * already looking at.
 *
 * The conversation itself lives in agent-conversation.tsx; this file is the
 * shell — the launcher, the panel, and the page context it passes down.
 */
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Sparkles, X } from 'lucide-react';
import { AgentConversation, type AgentStatus } from './agent-conversation';

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Escape closes the panel — it overlays the dashboard on narrow viewports.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pageContext = {
    page: pathname.replace(/^\//, '') || 'executive',
    month: searchParams.get('month') ?? undefined,
    division: searchParams.get('division') ?? undefined,
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-[12.5px] font-medium shadow-lg transition-transform hover:scale-[1.02]"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        <Sparkles size={14} aria-hidden />
        Ask the data
      </button>
    );
  }

  return (
    <aside
      /*
       * Fixed on narrow viewports, sticky and viewport-height from xl up.
       *
       * `xl:static` alone was a real bug: in flow, the panel had no bounded
       * height, so its conversation area — which relies on `overflow-y-auto` —
       * never scrolled internally. The page scrolled instead, taking the
       * header and the whole transcript off screen and leaving just the
       * composer floating at the bottom. Pinning it to the viewport is what
       * makes the internal scroll work at all.
       */
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[420px] flex-col border-l shadow-2xl xl:sticky xl:top-0 xl:z-auto xl:h-dvh xl:shadow-none"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
      aria-label="Data assistant"
    >
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={14} aria-hidden style={{ color: 'var(--series-1)' }} />
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold leading-tight tracking-tight">Assistant</h2>
            {/* Which model is answering. Not vanity: the assistant behaves
                quite differently across models, and when an answer looks off
                the first useful question is which one produced it. */}
            {status && (
              <p className="truncate text-[10px] leading-tight text-[var(--text-muted)]">
                {status.assistant.configured
                  ? `${status.assistant.provider} · ${status.assistant.model}`
                  : 'No model configured — dashboards still work'}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: 'var(--text-secondary)' }}
        >
          <X size={15} aria-hidden />
          <span className="sr-only">Close assistant</span>
        </button>
      </header>

      <AgentConversation pageContext={pageContext} onStatus={setStatus} />
    </aside>
  );
}
