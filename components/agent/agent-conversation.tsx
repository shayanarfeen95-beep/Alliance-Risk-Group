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
import { useEffect, useRef, useState } from 'react';
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

/**
 * What it does, as verbs.
 *
 * The panel used to open on four example questions, and that framing was the
 * problem: a list of questions reads as a form to fill in, not as somebody you
 * hand work to. These are capabilities, each with one example — the example is
 * there to show the shape of a request, not to be the only thing you can say.
 *
 * "Import" is conditional. It used to be offered whether or not a source was
 * connected, so the one capability people most wanted to try was also the one
 * most likely to fail on the first attempt.
 */
const CAPABILITIES: Array<{
  id: string;
  verb: string;
  detail: string;
  example: string;
  needsSource?: boolean;
}> = [
  {
    id: 'analyse',
    verb: 'Answer with a figure you can check',
    detail: 'Every number is cited and links to the view it came from.',
    example: 'What was LITS gross margin in March, and how does it compare to budget?',
  },
  {
    id: 'explain',
    verb: 'Explain a movement',
    detail: 'Breaks a line down to the accounts behind it.',
    example: 'Why did Claims lose money in March?',
  },
  {
    id: 'chart',
    verb: 'Build a chart',
    detail: 'Emits a validated spec rendered by the same component the dashboards use.',
    example: 'Show revenue by division for the last 12 months',
  },
  {
    id: 'records',
    verb: 'Pull the underlying records',
    detail: 'Deals, GL accounts, sheet cells — the working behind a total.',
    example: 'Which deals closed in March, and who owned them?',
  },
  {
    id: 'import',
    verb: 'Import fresh data',
    detail: 'Shows you what it will pull; nothing is written until you confirm.',
    example: 'Pull March from QuickBooks',
    needsSource: true,
  },
];

export interface AgentStatus {
  assistant: { configured: boolean; provider: string | null; model: string | null; detail: string };
  sources: Array<{ source: string; label: string; connected: boolean; account: string | null }>;
  canImport: boolean;
}

export function AgentConversation({
  pageContext,
  onStatus,
}: {
  pageContext: PageContext;
  onStatus?: (status: AgentStatus) => void;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent/status')
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload.ok) return;
        setStatus(payload as AgentStatus);
        onStatus?.(payload as AgentStatus);
      })
      .catch(() => {
        // The panel works without this; it only changes what the empty state
        // can promise.
      });
    return () => {
      cancelled = true;
    };
    // Runs once: the connection state is read when the panel mounts, and the
    // panel remounts on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            <div>
              <p className="text-[13px] font-semibold tracking-tight">
                Give it something to do.
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                It works inside this dashboard, already knowing the month, division and page you
                are on. Ask in your own words — the examples below are shapes, not a menu.
              </p>
            </div>

            {/* What is actually connected. An agent that offers to import from
                HubSpot when HubSpot is not connected is worse than one that
                says so up front, because the failure lands after the ask. */}
            {status && (
              <div
                className="rounded-[var(--radius)] border p-2.5"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
              >
                <p
                  className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Connected sources
                </p>
                <ul className="space-y-0.5">
                  {status.sources.map((source) => (
                    <li key={source.source} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          background: source.connected
                            ? 'var(--status-good)'
                            : 'var(--text-muted)',
                        }}
                      />
                      <span style={{ color: source.connected ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {source.label}
                      </span>
                      <span className="truncate text-[10.5px] text-[var(--text-muted)]">
                        {source.connected ? (source.account ?? 'connected') : 'not connected'}
                      </span>
                    </li>
                  ))}
                </ul>
                {status.sources.every((source) => !source.connected) && (
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                    Nothing is connected yet, so it can read the warehouse but cannot fetch
                    anything new. Connect a source in Admin.
                  </p>
                )}
              </div>
            )}

            <ul className="space-y-1.5">
              {CAPABILITIES.filter(
                (capability) =>
                  !capability.needsSource ||
                  (status?.canImport && status.sources.some((source) => source.connected)),
              ).map((capability) => (
                <li key={capability.id}>
                  <button
                    type="button"
                    onClick={() => setInput(capability.example)}
                    className="w-full rounded-[var(--radius)] border px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span className="block text-[12px] font-medium leading-snug">
                      {capability.verb}
                    </span>
                    <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                      {capability.detail}
                    </span>
                    <span
                      className="mt-1 block text-[11px] leading-snug"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      &ldquo;{capability.example}&rdquo;
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              <ShieldCheck size={12} className="mt-px shrink-0" aria-hidden style={{ color: 'var(--status-good)' }} />
              <span>
                Figures come from the same definitions the dashboards use, so it cannot disagree
                with the screen behind it. When the data will not support an answer it says so
                instead of estimating, and nothing is ever written to a source.
              </span>
            </p>
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
