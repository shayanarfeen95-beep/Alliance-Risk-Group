'use client';

/**
 * The assistant, present on every page.
 *
 * It reads the current month, division and dashboard from the URL, so a request
 * like "why did Claims lose money?" never has to restate the context the user is
 * already looking at.
 *
 * Open or closed is remembered. That sounds trivial and is not: the previous
 * version closed itself on every navigation, so somebody who wanted the
 * assistant beside them while they read had to reopen it on each page, and the
 * conversation started over each time. Left open, it docks beside the dashboard
 * on a wide screen rather than covering it.
 *
 * The conversation itself lives in agent-conversation.tsx; this file is the
 * shell — the launcher, the panel, and the page context it passes down.
 */
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { MessageSquarePlus, Sparkles, X } from 'lucide-react';
import { AgentConversation } from './agent-conversation';

const OPEN_KEY = 'arg.assistant.open.v1';

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Restored after mount so the server-rendered tree and the first client
  // render agree.
  useEffect(() => {
    setOpen(window.localStorage.getItem(OPEN_KEY) === '1');
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function openPanel() {
    setOpen(true);
    window.localStorage.setItem(OPEN_KEY, '1');
  }

  function close() {
    setOpen(false);
    window.localStorage.setItem(OPEN_KEY, '0');
  }

  const pageContext = {
    page: pathname.replace(/^\//, '') || 'executive',
    month: searchParams.get('month') ?? undefined,
    division: searchParams.get('division') ?? undefined,
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
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
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[420px] flex-col border-l shadow-2xl xl:static xl:z-auto xl:shadow-none"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
      aria-label="Data assistant"
    >
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={14} aria-hidden style={{ color: 'var(--series-1)' }} />
          <h2 className="text-[13px] font-semibold tracking-tight">Assistant</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setResetSignal((value) => value + 1)}
            title="Start a new conversation"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <MessageSquarePlus size={15} aria-hidden />
            <span className="sr-only">New conversation</span>
          </button>
          <button
            type="button"
            onClick={close}
            title="Close the assistant"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X size={15} aria-hidden />
            <span className="sr-only">Close assistant</span>
          </button>
        </div>
      </header>

      <AgentConversation pageContext={pageContext} resetSignal={resetSignal} />
    </aside>
  );
}
