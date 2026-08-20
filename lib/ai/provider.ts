import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Which model serves the assistant.
 *
 * The agent loop was written against the Anthropic SDK directly, which meant
 * the assistant was unavailable to anyone without an Anthropic key — and the
 * whole conversational layer is the part ARG most wants to try before
 * committing to a bill.
 *
 * So the loop now talks to this interface, and two things implement it:
 * Anthropic, and any OpenAI-compatible endpoint, which is what OpenRouter
 * serves. Neither is privileged; the one that runs is whichever is configured.
 *
 * The tools are the same objects in both cases. That matters more than it
 * looks: the guarantees this system makes about the assistant — that it cannot
 * compute its own figure, that it cannot write to a source, that it cannot
 * reach another division's rows — are properties of the tool surface, not of
 * the model. Changing model does not weaken any of them, and cannot.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Provider-neutral conversation state, converted at the edge. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  /** The provider declined outright rather than answering. */
  refused: boolean;
}

export interface ModelProvider {
  id: 'anthropic' | 'openrouter';
  label: string;
  model: string;
  complete(request: {
    system: string;
    messages: AgentMessage[];
    tools: ToolSpec[];
  }): Promise<ProviderResponse>;
}

export class AgentNotConfiguredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AgentNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * OpenRouter wins when both are set.
 *
 * Deliberate: somebody who has gone to the trouble of setting an OpenRouter key
 * on a deployment that already had an Anthropic one is switching, and silently
 * continuing to bill the Anthropic account would be the wrong reading of that.
 */
export function selectProvider(): ModelProvider | null {
  if (process.env.OPENROUTER_API_KEY) return openRouterProvider();
  if (process.env.ANTHROPIC_API_KEY) return anthropicProvider();
  return null;
}

export function isAgentConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/** What Admin shows, without revealing any part of a key. */
export function describeProvider(): {
  configured: boolean;
  provider: string | null;
  model: string | null;
  detail: string;
} {
  const provider = selectProvider();
  if (!provider) {
    return {
      configured: false,
      provider: null,
      model: null,
      detail:
        'Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY to enable the assistant. Every dashboard, ' +
        'export and control works without it — only the conversational layer is unavailable.',
    };
  }

  return {
    configured: true,
    provider: provider.label,
    model: provider.model,
    detail:
      provider.id === 'openrouter'
        ? 'OpenRouter is serving the assistant. The model must support tool calling — the assistant is nothing but tool calls, and a model without it will answer confidently from nothing.'
        : 'Anthropic is serving the assistant.',
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicProvider(): ModelProvider {
  const model = process.env.ANTHROPIC_MODEL_INTERACTIVE ?? 'claude-sonnet-5';

  return {
    id: 'anthropic',
    label: 'Anthropic',
    model,

    async complete({ system, messages, tools }) {
      const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
      const client = new AnthropicClient();

      const response = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
        })),
        messages: toAnthropicMessages(messages) as Anthropic.MessageParam[],
      });

      if (response.stop_reason === 'refusal') {
        return { text: '', toolCalls: [], refused: true };
      }

      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim(),
        toolCalls: response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          })),
        refused: false,
      };
    },
  };
}

/**
 * Anthropic wants tool results batched into one user message.
 *
 * Splitting them across messages trains the model out of parallel tool calls,
 * which roughly doubles the number of round trips on any question that needs
 * two figures — and most useful questions need two figures.
 */
export function toAnthropicMessages(messages: AgentMessage[]): Array<{
  role: 'user' | 'assistant';
  content: unknown;
}> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  let pendingResults: unknown[] = [];

  const flush = () => {
    if (pendingResults.length > 0) {
      out.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }

    flush();

    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : message.content });
  }

  flush();
  return out;
}

// ---------------------------------------------------------------------------
// OpenRouter (and any other OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * No default model, on purpose.
 *
 * Which free models OpenRouter offers, and which of those support tool calling,
 * changes month to month — a model id hardcoded today is a model id that 404s
 * or silently loses tool support later. The assistant is nothing but tool
 * calls, so a model without them does not degrade: it answers confidently with
 * numbers it invented, which is the single worst failure this system can have.
 *
 * So the model is named explicitly, and `verifyOpenRouterModel` checks it
 * against OpenRouter's live catalogue before anyone trusts it.
 */
function openRouterProvider(): ModelProvider {
  const model = process.env.OPENROUTER_MODEL;

  if (!model) {
    throw new AgentNotConfiguredError(
      'OPENROUTER_API_KEY is set but OPENROUTER_MODEL is not. Name a model that supports tool ' +
        'calling — the assistant is entirely tool calls, and one without them will answer from ' +
        'nothing rather than fail. Admin → Assistant checks a model before you rely on it.',
    );
  }

  return {
    id: 'openrouter',
    label: 'OpenRouter',
    model,

    async complete({ system, messages, tools }) {
      const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
          // OpenRouter attributes traffic by these; they are not secrets.
          'HTTP-Referer': process.env.OAUTH_REDIRECT_BASE ?? 'https://alliance-risk-group.vercel.app',
          'X-Title': 'Alliance Risk Group — FP&A',
        },
        body: JSON.stringify({
          model,
          messages: toOpenAiMessages(system, messages),
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
          // Let the model decide, but make tools available on every turn.
          tool_choice: 'auto',
          max_tokens: 8000,
        }),
      });

      const body = await response.text();

      if (!response.ok) {
        throw new Error(
          `OpenRouter returned HTTP ${response.status}: ${body.slice(0, 400)}. ` +
            'No figure was produced — do not treat this as an empty answer.',
        );
      }

      let parsed: OpenAiCompletion;
      try {
        parsed = JSON.parse(body) as OpenAiCompletion;
      } catch {
        throw new Error(`OpenRouter returned a body that is not JSON: ${body.slice(0, 200)}`);
      }

      // OpenRouter surfaces upstream provider errors inside a 200.
      if (parsed.error) {
        throw new Error(`OpenRouter: ${parsed.error.message ?? 'unknown provider error'}`);
      }

      const choice = parsed.choices?.[0];
      if (!choice) throw new Error('OpenRouter returned no choices.');

      const calls = choice.message?.tool_calls ?? [];

      return {
        text: (choice.message?.content ?? '').trim(),
        toolCalls: calls.map((call, index) => ({
          // Some providers omit the id. The loop needs one to match results to
          // calls, and a missing one would silently pair the wrong result with
          // the wrong call.
          id: call.id ?? `call_${index}`,
          name: call.function?.name ?? '',
          input: parseArguments(call.function?.arguments),
        })),
        refused: choice.finish_reason === 'content_filter',
      };
    },
  };
}

interface OpenAiCompletion {
  error?: { message?: string };
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/**
 * Tool arguments arrive as a JSON *string* rather than an object.
 *
 * Smaller models emit malformed JSON here more often than they should. An empty
 * object is the right fallback: every tool defaults its arguments to the
 * month, division and dashboard the user is already looking at, so a mangled
 * call degrades to the current context rather than throwing.
 */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toOpenAiMessages(
  system: string,
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      });
      continue;
    }

    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    const entry: Record<string, unknown> = { role: 'assistant', content: message.content || null };
    if (message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      }));
    }
    out.push(entry);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Model verification
// ---------------------------------------------------------------------------

export interface ModelCheck {
  ok: boolean;
  model: string;
  supportsTools: boolean;
  contextLength: number | null;
  isFree: boolean | null;
  detail: string;
}

/**
 * Does the configured model actually support tool calling?
 *
 * Worth a network round trip, because the failure it prevents is silent. A
 * model without tool support does not error — it reads the question, sees no
 * way to look anything up, and answers from its own weights. The reply looks
 * exactly like a good one and every figure in it is invented.
 *
 * OpenRouter publishes `supported_parameters` per model, so this is a fact we
 * can check rather than a property we have to hope for.
 */
export async function verifyOpenRouterModel(model: string): Promise<ModelCheck> {
  const fail = (detail: string): ModelCheck => ({
    ok: false,
    model,
    supportsTools: false,
    contextLength: null,
    isFree: null,
    detail,
  });

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return fail(
      `OpenRouter could not be reached (${error instanceof Error ? error.message : 'network error'}), so the model could not be checked.`,
    );
  }

  if (!response.ok) {
    return fail(`OpenRouter's model catalogue returned HTTP ${response.status}.`);
  }

  let catalogue: {
    data?: Array<{
      id?: string;
      context_length?: number;
      supported_parameters?: string[];
      pricing?: { prompt?: string; completion?: string };
    }>;
  };
  try {
    catalogue = (await response.json()) as typeof catalogue;
  } catch {
    return fail("OpenRouter's model catalogue was not valid JSON.");
  }

  const entry = catalogue.data?.find((candidate) => candidate.id === model);
  if (!entry) {
    return fail(
      `OpenRouter does not list a model called "${model}". Check the exact id at openrouter.ai/models — ` +
        'ids include the vendor prefix and, for the free tier, a ":free" suffix.',
    );
  }

  const supportsTools = (entry.supported_parameters ?? []).includes('tools');
  const isFree =
    entry.pricing !== undefined
      ? Number(entry.pricing.prompt ?? '1') === 0 && Number(entry.pricing.completion ?? '1') === 0
      : null;

  if (!supportsTools) {
    return {
      ok: false,
      model,
      supportsTools: false,
      contextLength: entry.context_length ?? null,
      isFree,
      detail:
        `"${model}" does not support tool calling, so the assistant cannot use it. It would not ` +
        'fail visibly — it would answer from its own weights with figures that came from nowhere. ' +
        'Pick a model whose OpenRouter listing includes "tools" under supported parameters.',
    };
  }

  return {
    ok: true,
    model,
    supportsTools: true,
    contextLength: entry.context_length ?? null,
    isFree,
    detail:
      `"${model}" supports tool calling` +
      (entry.context_length ? `, ${entry.context_length.toLocaleString()} token context` : '') +
      (isFree === true ? ', and is free.' : isFree === false ? ', and is billed per token.' : '.'),
  };
}
