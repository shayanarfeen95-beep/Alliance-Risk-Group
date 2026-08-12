'use client';

/**
 * The conversation surface.
 *
 * Two things it deliberately does NOT do:
 *   - render numbers the model typed. Every figure on screen arrives inside a
 *     citation or a view spec that the server resolved through the semantic
 *     layer.
 *   - render model-authored markup. A generated chart is a validated view spec
 *     passed to the same ChartCard the dashboards use.
 */
import { useRef, useState } from 'react';
import { ArrowUp, CircleAlert, Database, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
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
  verifyHref?: string;
  isRefusal?: boolean;
  /** A pending write the user must confirm before anything is committed. */
  pendingAction?: {
    id: string;
    label: string;
    detail: string;
  };
}

const SUGGESTIONS = [
  'What was LITS gross margin in March, and how does it compare to budget?',
  'Show revenue by division for the last 12 months',
  'Why did Claims lose money in March?',
  'Pull the latest month from QuickBooks',
];

export function AgentConversation({ pageContext }: { pageContext: PageContext }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        }),
      });

      const payload = (await response.json()) as
        | { ok: true; message: AgentMessage }
        | { ok: false; error: string };

      if (!payload.ok) {
        setError(payload.error);
      } else {
        setMessages((current) => [...current, payload.message]);
      }
    } catch {
      setError('Could not reach the assistant. Your session is still signed in — try again.');
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      });
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
      else setMessages((current) => [...current, payload.message]);
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
                Answers come from the same definitions the dashboards use
              </p>
              <p>
                Every figure is cited and links to the view you can check it against. When the data
                does not support an answer, it says so rather than estimating. It can also pull fresh
                data from QuickBooks, HubSpot or Sheets — it will show you what it plans to do before
                anything is written.
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
            placeholder="Ask about the numbers, or ask it to pull data…"
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
