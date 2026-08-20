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
 *   • **Dropped tool calls.** The assistant's whole surface is tool calling, so
 *     an assistant turn that loses its `tool_calls` on the way back into the
 *     conversation leaves the model unable to see what it just asked for.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  toOpenAiMessages,
  verifyOpenRouterModel,
  describeProvider,
  isAgentConfigured,
  DEFAULT_OPENROUTER_MODEL,
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

describe('the OpenAI-compatible conversion', () => {
  it('puts the system prompt first and each result in its own message', () => {
    const converted = toOpenAiMessages('You are the analyst.', conversation);

    expect(converted[0]).toEqual({ role: 'system', content: 'You are the analyst.' });
    // One message per result, each carrying the id of the call it answers.
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
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reports unconfigured without a key, and says the dashboards still work', () => {
    expect(isAgentConfigured()).toBe(false);
    expect(describeProvider().configured).toBe(false);
    expect(describeProvider().detail).toMatch(/dashboard/i);
  });

  it('uses the named model when one is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_MODEL = 'vendor/model:free';
    expect(describeProvider().provider).toBe('OpenRouter');
    expect(describeProvider().model).toBe('vendor/model:free');
  });

  it('falls back to the model ARG chose', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    // A hardcoded default carries real risk — the free tier changes, and a
    // withdrawn model fails silently rather than loudly. It stands because it
    // is the model ARG asked for, and Admin → Assistant re-checks it against
    // the live catalogue.
    expect(describeProvider().model).toBe(DEFAULT_OPENROUTER_MODEL);
  });
});

describe('commentary loads outside a request', () => {
  it('imports from plain Node without tripping the server-only guard', async () => {
    // The seed and the overnight refresh both draft commentary outside a
    // request. `lib/ai/provider` carries a `server-only` marker that throws the
    // moment it is imported there, so commentary must check for a key before
    // importing it — not after.
    //
    // Wiring this up with a static import broke `pnpm db:seed` outright, which
    // is a good outcome (loud, immediate) but only because the seed happened to
    // exercise it. This asserts it directly.
    delete process.env.OPENROUTER_API_KEY;

    const module = await import('@/lib/ai/commentary');
    expect(typeof module.generateCommentary).toBe('function');
  });
});
