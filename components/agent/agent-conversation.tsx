'use client';

/**
 * The conversation surface.
 *
 * Two things it deliberately does NOT do:
 *   - render numbers the model typed. Every figure on screen arrives inside a
 *     citation or a view spec that the server resolved through the semantic
 *     layer.
 *   - render model-authored markup. A generated chart is a validated view spec
 *     passed to the same ChartCard the dashboards use, and the prose is
 *     formatted by a small renderer here rather than by injecting HTML.
 *
 * The answer streams. A question worth asking a finance system costs several
 * lookups, and a spinner held for that long is indistinguishable from a hang —
 * which is most of what "the assistant does not work" turns out to mean.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  CircleAlert,
  Database,
  RefreshCw,
  Square,
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
  verifyHref?: string;
  isRefusal?: boolean;
  /** True while the answer is still arriving. */
  streaming?: boolean;
  /** A pending write the user must confirm before anything is committed. */
  pendingAction?: {
    id: string;
    label: string;
    detail: string;
  };
}

/**
 * Openers grouped by what they are for.
 *
 * The old list mixed "show revenue by division" with "pull the latest month from
 * QuickBooks" in one undifferentiated column, which made a read and a write look
 * like the same kind of act.
 */
const SUGGESTION_GROUPS: Array<{ label: string; items: string[] }> = [
  {
    label: 'Read the numbers',
    items: [
      'What was LITS gross margin last month, and how does it compare to budget?',
      'Show revenue by division for the last 12 months',
      'Why did Claims lose money in the most recent closed month?',
    ],
  },
  {
    label: 'Check the plumbing',
    items: [
      'Are these figures from our own books, or seeded demonstration data?',
      'What still needs doing before QuickBooks can supply data?',
      'Pull the latest month from QuickBooks',
    ],
  },
];

export function AgentConversation({ pageContext }: { pageContext: PageContext }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pinnedToBottom = useRef(true);

  // Follow the answer as it streams, but stop following the moment the reader
  // scrolls up — yanking someone back to the bottom while they are reading is
  // the single most irritating thing a chat panel can do.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottom.current = distance < 80;
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinnedToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  function updateLast(mutate: (message: AgentMessage) => AgentMessage) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (!last || last.role !== 'assistant') return current;
      next[next.length - 1] = mutate(last);
      return next;
    });
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setError(null);
    setInput('');
    pinnedToBottom.current = true;

    const history = [...messages, { role: 'user' as const, content: text }];
    setMessages([...history, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          pageContext,
        }),
        signal: controller.signal,
      });

      if (!response.body) throw new Error('The assistant returned no response body.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Server-sent events are separated by a blank line; a partial event at
        // the end of a chunk stays in the buffer until the rest arrives.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const block of events) {
          const line = block.split('\n').find((candidate) => candidate.startsWith('data: '));
          if (!line) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (event.type) {
            case 'text':
              updateLast((message) => ({
                ...message,
                content: message.content + String(event.delta ?? ''),
              }));
              break;
            case 'activity':
              updateLast((message) => ({
                ...message,
                activity: [
                  ...(message.activity ?? []),
                  { tool: String(event.tool), summary: String(event.summary) },
                ],
              }));
              break;
            case 'view':
              updateLast((message) => ({ ...message, view: event.view as ChartCardProps }));
              break;
            case 'citations':
              updateLast((message) => ({
                ...message,
                citations: event.citations as AgentCitation[],
              }));
              break;
            case 'pendingAction':
              updateLast((message) => ({
                ...message,
                pendingAction: event.pendingAction as AgentMessage['pendingAction'],
              }));
              break;
            case 'done': {
              const final = event.message as AgentMessage;
              updateLast(() => ({ ...final, streaming: false }));
              break;
            }
            case 'aborted':
              updateLast((message) => ({ ...message, streaming: false }));
              break;
            case 'error':
              setError(String(event.error));
              setMessages((current) =>
                current.filter((message, index) =>
                  index !== current.length - 1 ? true : message.content.length > 0,
                ),
              );
              break;
            default:
              break;
          }
        }
      }

      updateLast((message) => ({ ...message, streaming: false }));
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        updateLast((message) => ({ ...message, streaming: false }));
      } else {
        setError('Could not reach the assistant. Your session is still signed in — try again.');
        setMessages((current) => current.slice(0, -1));
      }
    } finally {
      abortRef.current = null;
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
        // The confirmed action is spent: leaving the button on screen invites a
        // second run of a load that already happened.
        setMessages((current) => [
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
                Answers come from the same definitions the dashboards use
              </p>
              <p>
                Every figure is cited and links to the view you can check it against. When the data
                does not support an answer, it says so rather than estimating. It can also pull
                fresh data from QuickBooks, HubSpot or Sheets — it will show you what it plans to do
                before anything is written.
              </p>
            </div>

            {SUGGESTION_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {group.label}
                </p>
                <ul className="space-y-1.5">
                  {group.items.map((suggestion) => (
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
            ))}
          </div>
        ) : null}

        {messages.map((message, index) => (
          <MessageBubble key={index} message={message} onConfirm={confirmAction} busy={busy} />
        ))}

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
        className="shrink-0 border-t p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        {messages.length > 0 && !busy ? (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
            className="mb-2 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <RefreshCw size={10} aria-hidden />
            Start a new conversation
          </button>
        ) : null}

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

          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              title="Stop"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
            >
              <Square size={9} fill="currentColor" aria-hidden />
              <span className="sr-only">Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
            >
              <ArrowUp size={13} aria-hidden />
              <span className="sr-only">Send</span>
            </button>
          )}
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

  const waiting = message.streaming && !message.content;

  return (
    <div className="space-y-2.5">
      {message.activity?.length ? (
        <ul className="space-y-1">
          {message.activity.map((item, index) => (
            <li
              key={index}
              className="flex items-start gap-1.5 text-[10.5px] text-[var(--text-muted)]"
            >
              <Database size={11} className="mt-0.5 shrink-0" aria-hidden />
              {item.summary}
            </li>
          ))}
        </ul>
      ) : null}

      {waiting ? (
        <p className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
          <ThinkingDots />
          Reading the figures
        </p>
      ) : (
        <div
          className="rounded-[var(--radius)] px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{
            background: message.isRefusal ? 'var(--status-warning-wash)' : 'transparent',
            border: message.isRefusal ? 'none' : `1px solid var(--border)`,
          }}
        >
          <Prose text={message.content} />
          {message.streaming ? <Caret /> : null}
        </div>
      )}

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

/**
 * Paragraphs, bullets and bold — nothing else.
 *
 * A finance answer is prose with the occasional list; supporting a full markdown
 * dialect here would mean rendering model-authored markup, which is exactly what
 * this surface refuses to do. Bold is included because a model reaches for it to
 * mark the figure that answers the question, and stripping it loses emphasis
 * the reader is meant to see.
 */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim());

  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        const isList = lines.every((line) => /^\s*[-*•]\s+/.test(line));

        if (isList) {
          return (
            <ul key={index} className={`space-y-1 pl-4 ${index > 0 ? 'mt-2' : ''}`}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex} className="list-disc">
                  <Emphasised text={line.replace(/^\s*[-*•]\s+/, '')} />
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={index} className={index > 0 ? 'mt-2' : undefined}>
            <Emphasised text={block} />
          </p>
        );
      })}
    </>
  );
}

function Emphasised({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={index} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** A cursor while text is arriving, so a pause reads as thinking, not as failure. */
function Caret() {
  return (
    <span
      className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] animate-pulse"
      style={{ background: 'var(--text-muted)' }}
      aria-hidden
    />
  );
}

function ThinkingDots() {
  return (
    <span className="flex gap-1" aria-hidden>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1 w-1 animate-bounce rounded-full"
          style={{ background: 'var(--text-muted)', animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  );
}
