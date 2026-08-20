/**
 * Talking to two different model APIs with one conversation.
 *
 * The agent is nothing but tool calls, so the conversions here are where the
 * whole thing quietly breaks. Two failure modes in particular are invisible
 * from the outside:
 *
 *   • **Mispaired results.** If a tool result is matched to the wrong call, the
 *     model receives March's revenue labelled as February's and answers
 *     confidently. Nothing errors.
 *   • **Unbatched results.** Anthropic wants every tool result for one turn in
 *     a single user message. Splitting them trains the model out of parallel
 *     calls, roughly doubling the round trips on any question needing two
 *     figures — which is most of them.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  toAnthropicMessages,
  toOpenAiMessages,
  verifyOpenRouterModel,
  describeProvider,
  isAgentConfigured,
  type AgentMessage,
} from '@/lib/ai/provider';

const conversation: AgentMessage[] = [
  { role: 'user', content: 'What was revenue in March and February?' },
  {
    role: 'assistant',
    content: 'Let me look both up.',
    toolCalls: [
      { id: 'call_a', name: 'get_kpi', input: { metric: 'revenue', month: '2026-03' } },
      { id: 'call_b', name: 'get_kpi', input: { metric: 'revenue', month: '2026-02' } },
    ],
  },
  { role: 'tool', toolCallId: 'call_a', name: 'get_kpi', content: '{"value":"$544,844"}' },
  { role: 'tool', toolCallId: 'call_b', name: 'get_kpi', content: '{"value":"$465,391"}' },
];

describe('the Anthropic conversion', () => {
  it('batches both tool results into one user message', () => {
    const converted = toAnthropicMessages(conversation);

    // user, assistant, then ONE user message holding both results.
    expect(converted).toHaveLength(3);
    expect(converted[2]!.role).toBe('user');
    expect(converted[2]!.content).toHaveLength(2);
  });

  it('keeps each result attached to the call that produced it', () => {
    const converted = toAnthropicMessages(conversation);
    const results = converted[2]!.content as Array<Record<string, unknown>>;

    const a = results.find((result) => result.tool_use_id === 'call_a')!;
    const b = results.find((result) => result.tool_use_id === 'call_b')!;

    // March is 544,844 and February is 465,391. Swapping them is the failure
    // that produces a confident, wrong answer with no error anywhere.
    expect(String(a.content)).toContain('544,844');
    expect(String(b.content)).toContain('465,391');
  });

  it('emits tool_use blocks the assistant turn can be replayed from', () => {
    const converted = toAnthropicMessages(conversation);
    const blocks = converted[1]!.content as Array<Record<string, unknown>>;

    const uses = blocks.filter((block) => block.type === 'tool_use');
    expect(uses).toHaveLength(2);
    expect(uses[0]!.id).toBe('call_a');
    expect(uses[0]!.input).toEqual({ metric: 'revenue', month: '2026-03' });
  });

  it('marks an errored result so the model does not read it as data', () => {
    const converted = toAnthropicMessages([
      { role: 'tool', toolCallId: 'x', name: 'get_kpi', content: 'failed', isError: true },
    ]);
    const results = converted[0]!.content as Array<Record<string, unknown>>;
    expect(results[0]!.is_error).toBe(true);
  });
});

describe('the OpenAI-compatible conversion', () => {
  it('puts the system prompt first and each result in its own message', () => {
    const converted = toOpenAiMessages('You are the analyst.', conversation);

    expect(converted[0]).toEqual({ role: 'system', content: 'You are the analyst.' });
    // OpenAI's shape is one message per result — the opposite of Anthropic's,
    // which is exactly why this conversion is not shared.
    expect(converted).toHaveLength(5);
    expect(converted[3]!.role).toBe('tool');
    expect(converted[4]!.role).toBe('tool');
  });

  it('keeps each result attached to its call id', () => {
    const converted = toOpenAiMessages('system', conversation);
    const a = converted.find((m) => m.tool_call_id === 'call_a')!;
    const b = converted.find((m) => m.tool_call_id === 'call_b')!;
    expect(String(a.content)).toContain('544,844');
    expect(String(b.content)).toContain('465,391');
  });

  it('serialises tool arguments as a JSON string, which is what the API expects', () => {
    const converted = toOpenAiMessages('system', conversation);
    const assistant = converted[2]!;
    const calls = assistant.tool_calls as Array<Record<string, unknown>>;

    expect(calls).toHaveLength(2);
    const fn = calls[0]!.function as Record<string, unknown>;
    expect(typeof fn.arguments).toBe('string');
    expect(JSON.parse(fn.arguments as string)).toEqual({ metric: 'revenue', month: '2026-03' });
  });
});

describe('verifying an OpenRouter model', () => {
  const realFetch = globalThis.fetch;

  function stubCatalogue(body: unknown, status = 200) {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('accepts a model that lists tool support', async () => {
    stubCatalogue({
      data: [
        {
          id: 'some-vendor/some-model:free',
          context_length: 131072,
          supported_parameters: ['tools', 'tool_choice', 'temperature'],
          pricing: { prompt: '0', completion: '0' },
        },
      ],
    });

    const check = await verifyOpenRouterModel('some-vendor/some-model:free');
    expect(check.ok).toBe(true);
    expect(check.supportsTools).toBe(true);
    expect(check.isFree).toBe(true);
    expect(check.contextLength).toBe(131072);
  });

  it('rejects a model without tool support, and says why it matters', async () => {
    stubCatalogue({
      data: [
        {
          id: 'some-vendor/chat-only:free',
          context_length: 8192,
          supported_parameters: ['temperature', 'top_p'],
          pricing: { prompt: '0', completion: '0' },
        },
      ],
    });

    const check = await verifyOpenRouterModel('some-vendor/chat-only:free');
    expect(check.ok).toBe(false);
    // The point of the check: this failure is otherwise silent. The model
    // answers from its weights and the reply looks fine.
    expect(check.detail).toMatch(/from nowhere|own weights/i);
  });

  it('says the model is not listed rather than assuming it is fine', async () => {
    stubCatalogue({ data: [{ id: 'other/model', supported_parameters: ['tools'] }] });
    const check = await verifyOpenRouterModel('typo/in-the-id:free');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/does not list/i);
  });

  it('reports a paid model as paid rather than refusing it', async () => {
    stubCatalogue({
      data: [
        {
          id: 'vendor/paid-model',
          context_length: 200000,
          supported_parameters: ['tools'],
          pricing: { prompt: '0.000003', completion: '0.000015' },
        },
      ],
    });
    const check = await verifyOpenRouterModel('vendor/paid-model');
    expect(check.ok).toBe(true);
    expect(check.isFree).toBe(false);
    expect(check.detail).toMatch(/billed per token/i);
  });

  it('does not blame the model when the network is the problem', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch;

    const check = await verifyOpenRouterModel('vendor/model');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/could not be reached/i);
  });
});

describe('provider selection', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reports unconfigured without either key, and says the dashboards still work', () => {
    expect(isAgentConfigured()).toBe(false);
    expect(describeProvider().configured).toBe(false);
    expect(describeProvider().detail).toMatch(/dashboard/i);
  });

  it('prefers OpenRouter when both are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_MODEL = 'vendor/model:free';

    // Setting an OpenRouter key on a deployment that already had an Anthropic
    // one is a switch. Quietly continuing to bill Anthropic misreads it.
    expect(describeProvider().provider).toBe('OpenRouter');
    expect(describeProvider().model).toBe('vendor/model:free');
  });

  it('refuses to start OpenRouter without a named model', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    // No default model on purpose: which free models exist and which support
    // tools changes month to month, and a stale default fails silently.
    expect(() => describeProvider()).toThrow(/OPENROUTER_MODEL/);
  });
});
