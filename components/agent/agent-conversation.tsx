'use client';

/**
 * The conversation surface.
 *
 * Three things it deliberately does NOT do:
 *   - render numbers the model typed. Every figure on screen arrives inside a
 *     citation or a view spec that the server resolved through the semantic
 *     layer.
 *   - render model-authored markup. A generated chart is a validated view spec
 *     passed to the same ChartCard the dashboards use.
 *   - forget. The transcript is held in local storage and the thread id travels
 *     with it, so moving between dashboards — which is most of what anyone does
 *     here — continues the same conversation instead of starting a new one. An
 *     assistant that loses the thread every time you click a tab is an
 *     assistant people stop opening.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  CircleAlert,
  Database,
  ExternalLink,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { ChartCard, type ChartCardProps } from '@/components/charts/chart-card';

export interface PageContext {
  page: string;
  month?: string;
  division?: string;
}

export interface AgentCitation {
  label: string;
  value: string;
  source: string;
  periodMonth?: string;
  divisionCode?: string;
}

export interface AgentToolActivity {
  tool: string;
  summary: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: AgentCitation[];
  activity?: AgentToolActivity[];
  /** A resolved view the server built from a validated spec. */
  view?: ChartCardProps;
  /** Places to go — a filtered dashboard, the mapping screen, a new box. */
  links?: Array<{ label: string; href: string }>;
  verifyHref?: string;
  isRefusal?: boolean;
  /** A pending write the user must confirm before anything is committed. */
  pendingAction?: {
    id: string;
    label: string;
    detail: string;
  };
}

/**
 * What it can do, said as things somebody would actually ask for.
 *
 * The four cover the four jobs: answer, build, map, guide.
 */
const SUGGESTIONS = [
  'Why did Claims lose money in March?',
  'Add a cash runway tile for LITS to the executive dashboard',
  'Which HubSpot values are not mapped to a division?',
  'How do I compare two divisions on one screen?',
];

const STORAGE_KEY = 'arg.assistant.transcript.v1';

interface StoredTranscript {
  conversationId: string | null;
  messages: AgentMessage[];
}

function loadStored(): StoredTranscript {
  if (typeof window === 'undefined') return { conversationId: null, messages: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversationId: null, messages: [] };
    const parsed = JSON.parse(raw) as StoredTranscript;
    if (!Array.isArray(parsed.messages)) return { conversationId: null, messages: [] };
    return { conversationId: parsed.conversationId ?? null, messages: parsed.messages };
  } catch {
    return { conversationId: null, messages: [] };
  }
}

export function AgentConversation({
  pageContext,
  resetSignal = 0,
}: {
  pageContext: PageContext;
  /** Incremented by the panel's "new chat" control. */
  resetSignal?: number;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restored after mount rather than during render: the server has no local
  // storage, and reading it in the initial state would hydrate a different tree
  // than it rendered.
  useEffect(() => {
    const stored = loadStored();
    setMessages(stored.messages);
    setConversationId(stored.conversationId);
  }, []);

  useEffect(() => {
    if (resetSignal === 0) return;
    setMessages([]);
    setConversationId(null);
    setError(null);
    window.localStorage.removeItem(STORAGE_KEY);
  }, [resetSignal]);

  useEffect(() => {
    if (messages.length === 0) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversationId, messages }));
    } catch {
      // A full or blocked storage quota must not break the conversation; it
      // simply stops surviving navigation.
    }
  }, [messages, conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setError(null);
    setInput('');

    const history = [...messages, { role: 'user' as const, content: text }];
    setMessages(history);
    setBusy(true);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          pageContext,
          conversationId,
        }),
      });

      const payload = (await response.json()) as
        | { ok: true; message: AgentMessage; conversationId?: string }
        | { ok: false; error: string };

      if (!payload.ok) {
        setError(payload.error);
      } else {
        if (payload.conversationId) setConversationId(payload.conversationId);
        setMessages((current) => [...current, payload.message]);
      }
    } catch {
      setError('Could not reach the assistant. Your session is still signed in — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction(actionId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId }),
      });
      const payload = (await response.json()) as
        | { ok: true; message: AgentMessage }
        | { ok: false; error: string };
      if (!payload.ok) setError(payload.error);
      else {
        setMessages((current) => [
          // The proposal has been acted on; leaving its button on screen invites
          // a second click that would fail.
          ...current.map((message) =>
            message.pendingAction?.id === actionId
              ? { ...message, pendingAction: undefined }
              : message,
          ),
          payload.message,
        ]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="space-y-4">
            <div
              className="rounded-[var(--radius)] p-3 text-[11.5px] leading-relaxed"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <p className="mb-1.5 flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <ShieldCheck size={13} aria-hidden style={{ color: 'var(--status-good)' }} />
                It works on the same definitions the dashboards use
              </p>
              <p>
                Ask it about the numbers and every figure comes back cited. It can also build boxes
                onto your dashboards, map HubSpot values to divisions, pull fresh data, and show you
                where things are. Anything that writes shows you what it plans to do first.
              </p>
            </div>

            <ul className="space-y-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    onClick={() => send(suggestion)}
                    className="w-full rounded-[var(--radius)] border px-3 py-2 text-left text-[12px] leading-snug transition-colors hover:bg-[var(--surface-2)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <MessageBubble key={index} message={message} onConfirm={confirmAction} busy={busy} />
        ))}

        {busy ? (
          <p className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
            <LoaderCircle size={13} className="animate-spin" aria-hidden />
            Working…
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2.5 text-[11.5px] leading-relaxed"
            style={{ background: 'var(--status-critical-wash)', color: 'var(--delta-bad)' }}
          >
            <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="border-t p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-end gap-2 rounded-[var(--radius)] border px-3 py-2"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-1)' }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="Ask about the numbers, or ask it to build something…"
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[var(--text-muted)]"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
            style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
          >
            <ArrowUp size={13} aria-hidden />
            <span className="sr-only">Send</span>
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
          Knows the page, month and division you are looking at. Enter sends, Shift+Enter for a new
          line.
        </p>
      </form>
    </>
  );
}

function MessageBubble({
  message,
  onConfirm,
  busy,
}: {
  message: AgentMessage;
  onConfirm: (actionId: string) => void;
  busy: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p
          className="max-w-[85%] rounded-[var(--radius)] px-3 py-2 text-[12.5px] leading-relaxed"
          style={{ background: 'var(--surface-2)' }}
        >
          {message.content}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {message.activity?.length ? (
        <ul className="space-y-1">
          {message.activity.map((item, index) => (
            <li key={index} className="flex items-start gap-1.5 text-[10.5px] text-[var(--text-muted)]">
              <Database size={11} className="mt-0.5 shrink-0" aria-hidden />
              {item.summary}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className="rounded-[var(--radius)] px-3 py-2.5 text-[12.5px] leading-relaxed"
        style={{
          background: message.isRefusal ? 'var(--status-warning-wash)' : 'transparent',
          border: message.isRefusal ? 'none' : `1px solid var(--border)`,
        }}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>

      {message.view ? <ChartCard {...message.view} /> : null}

      {message.links?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {message.links.map((link, index) => (
            <a
              key={index}
              href={link.href}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
            >
              <ExternalLink size={11} aria-hidden />
              {link.label}
            </a>
          ))}
        </div>
      ) : null}

      {message.citations?.length ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            <Sparkles size={10} className="mr-1 inline" aria-hidden />
            {message.citations.length} source figure{message.citations.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1.5 space-y-1 border-l pl-2.5" style={{ borderColor: 'var(--border)' }}>
            {message.citations.map((citation, index) => (
              <li key={index} className="flex items-baseline justify-between gap-3 text-[10.5px]">
                <span className="text-[var(--text-muted)]">
                  {citation.label}
                  {citation.divisionCode ? ` · ${citation.divisionCode}` : ''}
                  {citation.periodMonth ? ` · ${citation.periodMonth.slice(0, 7)}` : ''}
                </span>
                <span className="tnum shrink-0 text-[var(--text-secondary)]">
                  {citation.value}
                  <span className="ml-1.5 text-[var(--text-muted)]">{citation.source}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {message.pendingAction ? (
        <div
          className="rounded-[var(--radius)] border p-3"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }}
        >
          <p className="text-[12px] font-medium">{message.pendingAction.label}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {message.pendingAction.detail}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(message.pendingAction!.id)}
            className="mt-2.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-50"
            style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
          >
            Confirm and run
          </button>
        </div>
      ) : null}

      {message.verifyHref ? (
        <a
          href={message.verifyHref}
          className="inline-block text-[10.5px] underline-offset-2 hover:underline"
          style={{ color: 'var(--series-1)' }}
        >
          Open the view this came from →
        </a>
      ) : null}
    </div>
  );
}
