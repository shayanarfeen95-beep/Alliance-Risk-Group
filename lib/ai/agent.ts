import 'server-only';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import type { SemanticSession } from '@/lib/semantic/resolve';
import { AGENT_TOOLS, toolByName, type ToolContext } from './tools';
import { buildSystemPrompt, type PageContext } from './prompt';
import {
  activeModel,
  isModelConfigured,
  ModelNotConfiguredError,
  streamTurn,
  type AgentToolResult,
  type ConversationMessage,
} from './provider';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * The agent loop.
 *
 * A manual tool-use loop rather than a framework's runner: every tool call is
 * authorised and logged against the caller's entitlements before it runs, and
 * the loop needs the per-request semantic session in scope. Owning the loop
 * keeps that check in one place.
 *
 * The model is reached through lib/ai/provider.ts, so nothing here knows which
 * model answered — only that a figure it states came from a tool call made in
 * this loop.
 */

/**
 * Enough room to look something up, notice it does not answer the question, and
 * look up the right thing. Eight cut real chains of reasoning short — a variance
 * question legitimately costs a period check, a statement, the drivers, a
 * comparison and a chart before there is anything worth saying.
 */
const MAX_ITERATIONS = 14;

export interface AgentTurnInput {
  user: SessionUser;
  session: SemanticSession;
  pageContext: PageContext;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  conversationId: string | null;
  /**
   * Called as the turn happens, so the panel can show the answer being written
   * and the lookups being made rather than a spinner. A financial question can
   * legitimately take half a minute of tool calls; half a minute of "Working…"
   * reads as a broken application.
   */
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; tool: string; summary: string }
  | { type: 'citations'; citations: AgentCitation[] }
  | { type: 'view'; view: ChartCardProps }
  | { type: 'pendingAction'; pendingAction: { id: string; label: string; detail: string } };

export interface AgentCitation {
  label: string;
  value: string;
  source: string;
  periodMonth?: string;
  divisionCode?: string;
}

export interface AgentTurnResult {
  content: string;
  citations: AgentCitation[];
  activity: Array<{ tool: string; summary: string }>;
  view?: ChartCardProps;
  verifyHref?: string;
  isRefusal?: boolean;
  pendingAction?: { id: string; label: string; detail: string };
}

export { ModelNotConfiguredError as AgentNotConfiguredError } from './provider';

export function isAgentConfigured(): boolean {
  return isModelConfigured();
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  if (!isModelConfigured()) throw new ModelNotConfiguredError();

  const model = activeModel();
  const db = await getDb();
  const started = Date.now();

  const context: ToolContext = {
    db,
    user: input.user,
    session: input.session,
    conversationId: input.conversationId,
  };

  const tools = AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));

  const messages: ConversationMessage[] = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const activity: AgentTurnResult['activity'] = [];
  const citations: AgentCitation[] = [];
  const emit = input.onEvent ?? (() => {});
  let view: ChartCardProps | undefined;
  let pendingAction: AgentTurnResult['pendingAction'];

  /**
   * Text the model produced across the whole turn, including what it said before
   * reaching for a tool. It is streamed as it arrives, so the transcript and the
   * stream must agree — showing a preamble and then replacing it with something
   * shorter is how a working answer comes to look like a glitch.
   */
  let spoken = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const turn = await streamTurn({
      system: buildSystemPrompt(input.user, input.session, input.pageContext),
      tools,
      messages,
      signal: input.signal,
      onText: (delta) => {
        spoken += delta;
        emit({ type: 'text', delta });
      },
    });

    const toolUses = turn.toolCalls;

    if (toolUses.length === 0) {
      const text = spoken.trim();

      await logTurn(db, input, 'assistant', text, false, Date.now() - started, citations, model);

      if (citations.length) emit({ type: 'citations', citations });

      return {
        content: text || 'I could not produce an answer for that.',
        citations,
        activity,
        view,
        pendingAction,
      };
    }

    // A preamble before a tool call is a separate paragraph from whatever comes
    // after it. Without the break they run together mid-sentence.
    if (spoken && !spoken.endsWith('\n\n')) {
      spoken += '\n\n';
      emit({ type: 'text', delta: '\n\n' });
    }

    messages.push({ role: 'assistant_tool_use', text: turn.text, toolCalls: toolUses });

    // Results are collected for the whole round and appended together, so a
    // model that called three tools at once gets three answers at once rather
    // than being trained out of calling them in parallel.
    const toolResults: AgentToolResult[] = [];

    for (const toolUse of toolUses) {
      const tool = toolByName(toolUse.name);
      if (!tool) {
        toolResults.push({
          id: toolUse.id,
          content: `No such tool: ${toolUse.name}`,
          isError: true,
        });
        continue;
      }

      try {
        const outcome = await tool.run(toolUse.input ?? {}, context);

        if (outcome.activity) {
          activity.push({ tool: tool.name, summary: outcome.activity });
          emit({ type: 'activity', tool: tool.name, summary: outcome.activity });
        }
        if (outcome.view) {
          view = outcome.view;
          emit({ type: 'view', view: outcome.view });
        }
        if (outcome.pendingAction) {
          pendingAction = outcome.pendingAction;
          emit({ type: 'pendingAction', pendingAction: outcome.pendingAction });
        }
        if (outcome.citations) citations.push(...outcome.citations);

        await db.insert(t.aiQueryLog).values({
          conversationId: input.conversationId,
          userId: input.user.id,
          role: 'tool',
          toolName: tool.name,
          toolInput: (toolUse.input ?? {}) as object,
          toolOutput: outcome.result as object,
          model,
        });

        toolResults.push({ id: toolUse.id, content: JSON.stringify(outcome.result) });
      } catch (error) {
        toolResults.push({
          id: toolUse.id,
          content: `The tool failed: ${error instanceof Error ? error.message : 'unknown error'}. Do not guess the figure — tell the user it could not be retrieved.`,
          isError: true,
        });
      }
    }

    messages.push({ role: 'tool_results', results: toolResults });
  }

  return {
    content:
      spoken.trim() ||
      'I worked through several steps but did not reach a settled answer. Narrowing the question to one metric, division and month usually gets there.',
    citations,
    activity,
    view,
    pendingAction,
  };
}

async function logTurn(
  db: Awaited<ReturnType<typeof getDb>>,
  input: AgentTurnInput,
  role: string,
  content: string,
  wasRefusal: boolean,
  latencyMs: number,
  citations: AgentCitation[] = [],
  model: string = activeModel(),
): Promise<void> {
  // §11 Requirement 6: every question and answer is logged. Westport reviews
  // this during the audit pass, and the refusals are the most useful rows.
  await db.insert(t.aiQueryLog).values({
    conversationId: input.conversationId,
    userId: input.user.id,
    role,
    content,
    wasRefusal,
    citations: citations.length ? (citations as unknown as object) : null,
    model,
    latencyMs,
  });
}
