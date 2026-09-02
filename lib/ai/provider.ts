/**
 * The model provider: OpenRouter.
 *
 * One place where a model is called, so the agent loop, the commentary drafter
 * and anything added later share the same transport, the same failure messages
 * and the same model selection. The loop is where entitlements are checked and
 * every tool call is logged; keeping the transport out of it is what stops those
 * checks from drifting.
 *
 * No `server-only` marker: the seed loader and the overnight refresh both draft
 * commentary outside a request. The key is read inside each call rather than at
 * import, so nothing here runs on a key that is not present.
 *
 * ## On choosing a free model
 *
 * Free models advertise tool support far more often than they honour it. Of the
 * seventeen on OpenRouter that claim it, most either never call the tool, never
 * stop calling it, or — worst — answer the financial question from nothing at
 * all. `minimax/minimax-m3:free`, asked for LITS gross margin with a tool
 * available, replied "54.2%" without calling anything. In this system that is
 * not a weak answer; it is a fabricated figure on its way to ARG's CEO.
 *
 * The defaults below were picked by testing exactly that. Each is verified to
 * call a tool rather than guess, to chain two calls in sequence, and to say
 * plainly that a figure is unavailable when the tool refuses rather than
 * substituting a number. Anything that failed any of the three is not here.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_MODEL = 'minimax/minimax-m2.7:free';

/**
 * Tried in order when the primary is unavailable. Free models rate-limit
 * constantly — a 429 is the normal case, not the exception — and a single model
 * with no alternative is an assistant that works intermittently, which reads to
 * a user as an assistant that is broken.
 */
const DEFAULT_FALLBACKS = ['nvidia/nemotron-3.5-lightning:free', 'cohere/north-mini-code:free'];

export class ModelNotConfiguredError extends Error {
  constructor() {
    super(
      'The assistant has no model configured: OPENROUTER_API_KEY is not set. A free key is ' +
        'enough. Every dashboard, export and reconciliation control still works — only the ' +
        'conversational layer is unavailable.',
    );
    this.name = 'ModelNotConfiguredError';
  }
}

export function isModelConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The model asked for first. Recorded on every logged turn. */
export function activeModel(): string {
  return process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
}

function modelChain(): string[] {
  const configured = process.env.OPENROUTER_FALLBACK_MODELS?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return [activeModel(), ...(configured ?? DEFAULT_FALLBACKS)];
}

// ---------------------------------------------------------------------------
// Conversation types
// ---------------------------------------------------------------------------

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  id: string;
  /** The tool's output, already serialised. */
  content: string;
  isError?: boolean;
}

export type ConversationMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant_tool_use'; text: string; toolCalls: AgentToolCall[] }
  | { role: 'tool_results'; results: AgentToolResult[] };

export interface ProviderTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderTurn {
  text: string;
  toolCalls: AgentToolCall[];
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toWire(system: string, messages: ConversationMessage[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === 'assistant_tool_use') {
      out.push({
        role: 'assistant',
        content: message.text.trim() ? message.text : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      continue;
    }

    // One message per result. A tool result that does not answer a tool call the
    // assistant actually made is rejected by the API, which is why ids are
    // carried through rather than regenerated.
    for (const result of message.results) {
      out.push({ role: 'tool', tool_call_id: result.id, content: result.content });
    }
  }

  return out;
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'content-type': 'application/json',
    // OpenRouter attributes usage to the calling application by these. ASCII
    // only: a header value is a ByteString, and an em dash here throws before
    // the request is ever sent.
    'HTTP-Referer': process.env.OAUTH_REDIRECT_BASE ?? 'https://alliance-risk-group.local',
    'X-Title': 'Alliance Risk Group FP&A',
  };
}

function describeFailure(status: number, body: string): string {
  if (status === 401) return 'OPENROUTER_API_KEY was rejected. Check it has not been rotated.';
  if (status === 402) return 'The OpenRouter account is out of credit for this model.';
  if (status === 404) return 'The configured model does not exist. Check OPENROUTER_MODEL.';
  if (status === 429) {
    return 'Every configured model is rate limited. Free models limit aggressively — try again in ' +
      'a minute, or set OPENROUTER_MODEL to a paid one.';
  }
  return body.slice(0, 200) || 'No detail was returned.';
}

// ---------------------------------------------------------------------------
// Streaming a turn, with tools
// ---------------------------------------------------------------------------

export interface StreamTurnInput {
  system: string;
  tools: ProviderTool[];
  messages: ConversationMessage[];
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

interface StreamedCall {
  id: string;
  name: string;
  args: string;
}

export async function streamTurn(input: StreamTurnInput): Promise<ProviderTurn> {
  if (!isModelConfigured()) throw new ModelNotConfiguredError();

  const models = modelChain();

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: input.signal,
    headers: headers(),
    body: JSON.stringify({
      model: models[0],
      models,
      messages: toWire(input.system, input.messages),
      tools: input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      max_tokens: 4000,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `The model provider returned HTTP ${response.status}. ` +
        describeFailure(response.status, await response.text().catch(() => '')),
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, StreamedCall>();
  let text = '';
  let buffer = '';
  let failure: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      // OpenRouter sends ": OPENROUTER PROCESSING" keepalive comments.
      if (!line.startsWith('data: ')) continue;

      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;

      let event: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      // An error mid-stream arrives as an ordinary event. Left unread, it looks
      // exactly like a model that stopped talking for no reason.
      if (event.error?.message) {
        failure = event.error.message;
        continue;
      }

      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        input.onText(delta.content);
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = calls.get(index) ?? { id: '', name: '', args: '' };
        calls.set(index, {
          id: call.id ?? existing.id,
          name: call.function?.name ?? existing.name,
          // Arguments arrive as a JSON string, fragmented across many events.
          args: existing.args + (call.function?.arguments ?? ''),
        });
      }
    }
  }

  if (failure && !text && calls.size === 0) {
    throw new Error(`The model provider could not complete that: ${failure}`);
  }

  return {
    text,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArguments(call.args),
      })),
  };
}

/**
 * Tool arguments, or an empty object.
 *
 * Malformed JSON here must not take the turn down. The tool then rejects the
 * missing argument with a message the model can act on, which is a recoverable
 * step rather than a failed answer.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// A single completion, no tools
// ---------------------------------------------------------------------------

/**
 * One prose completion. Used by the commentary drafter, which has no tools and
 * no conversation — it is handed a fact pack and asked to write.
 */
export async function complete(input: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!isModelConfigured()) throw new ModelNotConfiguredError();

  const models = modelChain();

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: models[0],
      models,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      max_tokens: input.maxTokens ?? 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `The model provider returned HTTP ${response.status}. ` +
        describeFailure(response.status, await response.text().catch(() => '')),
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };

  if (body.error?.message) throw new Error(body.error.message);

  return (body.choices?.[0]?.message?.content ?? '').trim();
}
