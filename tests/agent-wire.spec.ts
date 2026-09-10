/**
 * The message list the model actually receives.
 *
 * A conversation broke like this, in production: the model finished a turn
 * having returned neither text nor a tool call, an empty assistant message was
 * kept in the history, and the NEXT question — and every question after it —
 * failed before reaching the model at all:
 *
 *   invalid message provided at index 3: must have non-empty content or tool calls
 *
 * The shape of that failure is what makes it worth testing. The provider
 * rejects the whole request rather than the offending message, so one empty
 * entry does not degrade an answer, it removes the assistant entirely; and
 * because the entry is replayed on every subsequent turn, the conversation
 * never recovers on its own. The user sees an assistant that has simply stopped
 * working, with nothing on screen connecting it to a turn that went blank
 * several questions ago.
 *
 * So the rule under test is: every message this produces must be sendable.
 */
import { describe, expect, it } from 'vitest';
import { toWireForTest } from '@/lib/ai/provider';
import type { ConversationMessage } from '@/lib/ai/provider';

const SYSTEM = 'You are the ARG assistant.';

/** Exactly the provider's own rule, asserted against every message. */
function sendable(message: { content?: string | null; tool_calls?: unknown[] }): boolean {
  const hasContent = typeof message.content === 'string' && message.content.length > 0;
  const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return hasContent || hasCalls;
}

describe('the wire format', () => {
  it('drops an assistant turn that said nothing', () => {
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'What were bookings in March?' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '??' },
    ]);

    expect(wire.every(sendable)).toBe(true);
    // The empty turn is gone; the two real messages remain, in order.
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('drops one padded with whitespace, which is the same thing', () => {
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '   \n  ' },
    ]);

    expect(wire.every(sendable)).toBe(true);
    expect(wire).toHaveLength(2);
  });

  it('keeps a tool-call turn that has no text, because the calls carry it', () => {
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'Bookings?' },
      {
        role: 'assistant_tool_use',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'resolve_kpi', input: { kpi: 'dollars_booked' } }],
      },
      { role: 'tool_results', results: [{ id: 'call_1', content: '{"value":366544}' }] },
    ]);

    expect(wire.every(sendable)).toBe(true);
    // Null content alongside tool_calls is legal and is how the API expects a
    // silent tool-call turn — it must NOT be dropped, or the tool result that
    // follows answers a call that was never made.
    const assistant = wire.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBeNull();
    expect(assistant?.tool_calls).toHaveLength(1);
  });

  it('drops a tool-call turn with neither text nor calls', () => {
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'Bookings?' },
      { role: 'assistant_tool_use', text: '', toolCalls: [] },
    ]);

    expect(wire.every(sendable)).toBe(true);
    expect(wire.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('never drops a tool result, even an empty one', () => {
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'Bookings?' },
      {
        role: 'assistant_tool_use',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'resolve_kpi', input: {} }],
      },
      { role: 'tool_results', results: [{ id: 'call_1', content: '' }] },
    ]);

    // A tool_call with no matching response is itself rejected, so an empty
    // result must be sent as a stated blank rather than removed.
    expect(wire.every(sendable)).toBe(true);
    const result = wire.find((m) => m.role === 'tool');
    expect(result?.tool_call_id).toBe('call_1');
    expect(result?.content).toMatch(/returned nothing/);
  });

  it('produces a sendable list from the exact history that broke', () => {
    // user → tool-call turn → results → EMPTY assistant → user "??"
    const wire = toWireForTest(SYSTEM, [
      { role: 'user', content: 'tell me about the deals and pipelines currently' },
      {
        role: 'assistant_tool_use',
        text: '',
        toolCalls: [{ id: 'c1', name: 'resolve_kpi', input: { kpi: 'pipeline_value' } }],
      },
      { role: 'tool_results', results: [{ id: 'c1', content: '{"value":1138337}' }] },
      { role: 'assistant', content: '' },
      { role: 'user', content: '??' },
    ] as ConversationMessage[]);

    expect(wire.every(sendable)).toBe(true);
  });
});
