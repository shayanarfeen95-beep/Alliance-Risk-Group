'use client';

/**
 * The assistant, present on every page.
 *
 * It reads the current month, division and dashboard from the URL, so a request
 * like "why did Claims lose money?" never has to restate the context the user is
 * already looking at.
 *
 * On layout, which was the complaint: the panel used to be a fixed overlay that
 * became a flex sibling at one breakpoint, so opening it either covered the
 * dashboard or shoved it sideways with no transition. It is now a docked column
 * that the page makes room for on a wide screen, and a proper overlay with a
 * scrim on a narrow one. Its width is remembered, and dragging the edge resizes
 * it — a conversation about a twelve-month chart needs more room than one about
 * a single figure.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { PanelRightClose, Sparkles } from 'lucide-react';
import { AgentConversation } from './agent-conversation';

const WIDTH_KEY = 'arg.assistant.width';
const OPEN_KEY = 'arg.assistant.open';
const MIN_WIDTH = 340;
const MAX_WIDTH = 720;

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(400);
  const [dragging, setDragging] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Restored after mount rather than read during render: the server has no way
  // to know this preference, and reading it during render would mismatch.
  useEffect(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(WIDTH_KEY));
      if (storedWidth >= MIN_WIDTH && storedWidth <= MAX_WIDTH) setWidth(storedWidth);
      setOpen(window.localStorage.getItem(OPEN_KEY) === '1');
    } catch {
      // A browser refusing storage is not a reason to fail to render.
    }
  }, []);

  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Ignored, as above.
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) setOpenPersisted(false);
      // The one shortcut worth having: the assistant is the thing you reach for
      // mid-thought, and reaching for it should not cost a mouse trip.
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpenPersisted(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpenPersisted]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - event.clientX));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // Ignored.
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, width]);

  const pageContext = {
    page: pathname.replace(/^\//, '') || 'executive',
    month: searchParams.get('month') ?? undefined,
    division: searchParams.get('division') ?? undefined,
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpenPersisted(true)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-[12.5px] font-medium shadow-lg transition-transform hover:scale-[1.02]"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        <Sparkles size={14} aria-hidden />
        Ask the data
        <kbd
          className="ml-1 hidden rounded px-1.5 py-0.5 text-[10px] font-normal opacity-60 sm:inline"
          style={{ background: 'var(--surface-1)', color: 'var(--text-primary)' }}
        >
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <>
      {/* On a narrow viewport the panel covers the page, so the page needs a way
          to be dismissed by clicking away from it. */}
      <button
        type="button"
        aria-label="Close assistant"
        onClick={() => setOpenPersisted(false)}
        className="fixed inset-0 z-20 bg-black/25 xl:hidden"
      />

      <aside
        className="fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l shadow-2xl xl:sticky xl:top-0 xl:z-auto xl:h-dvh xl:shrink-0 xl:self-start xl:shadow-none"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border)',
          maxWidth: `${width}px`,
        }}
        aria-label="Data assistant"
      >
        {/* The resize handle sits on the panel's leading edge and is invisible
            until pointed at, which is where a resize handle belongs. */}
        <div
          onPointerDown={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          className="absolute inset-y-0 left-0 hidden w-1 cursor-col-resize hover:bg-[var(--border-strong)] xl:block"
          style={{ background: dragging ? 'var(--border-strong)' : undefined }}
          role="separator"
          aria-orientation="vertical"
        />

        <header
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={14} aria-hidden style={{ color: 'var(--series-1)' }} />
            <h2 className="text-[13px] font-semibold tracking-tight">Assistant</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpenPersisted(false)}
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-secondary)' }}
            title="Close (Esc)"
          >
            <PanelRightClose size={15} aria-hidden />
            <span className="sr-only">Close assistant</span>
          </button>
        </header>

        <AgentConversation pageContext={pageContext} />
      </aside>
    </>
  );
}
