import 'server-only';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import type { SemanticSession } from '@/lib/semantic/resolve';
import { AGENT_TOOLS, toolByName, type ToolContext } from './tools';
import { buildSystemPrompt, type PageContext } from './prompt';
import {
  AgentNotConfiguredError,
  isAgentConfigured,
  selectProvider,
  type AgentMessage,
} from './provider';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * The agent loop.
 *
 * A manual tool-use loop rather than an SDK's tool runner: every tool call is
 * authorised and logged against the caller's entitlements before it runs, and
 * the loop needs the per-request semantic session in scope. Owning the loop
 * keeps that check in one place.
 *
 * Provider-neutral since the assistant stopped requiring an Anthropic key. The
 * loop does not know or care which model answered — and none of the guarantees
 * depend on it, because they are all properties of the tool surface. There is
 * no metric tool that computes its own figure and no connector method that
 * writes, whatever is on the other end of the socket.
 */

const MAX_ITERATIONS = 8;

export interface AgentTurnInput {
  user: SessionUser;
  session: SemanticSession;
  pageContext: PageContext;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  conversationId: string | null;
}

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

export { AgentNotConfiguredError, isAgentConfigured } from './provider';

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const provider = selectProvider();
  if (!provider) {
    throw new AgentNotConfiguredError(
      'The assistant is not configured. Set OPENROUTER_API_KEY (with OPENROUTER_MODEL) or ' +
        'ANTHROPIC_API_KEY. Every dashboard, export and control still works — only the ' +
        'conversational layer is unavailable.',
    );
  }

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

  const messages: AgentMessage[] = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const system = buildSystemPrompt(input.user, input.session, input.pageContext);

  const activity: AgentTurnResult['activity'] = [];
  const citations: AgentCitation[] = [];
  let view: ChartCardProps | undefined;
  let pendingAction: AgentTurnResult['pendingAction'];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await provider.complete({ system, messages, tools });

    if (response.refused) {
      await logTurn(db, input, 'assistant', 'Declined by the provider', true, Date.now() - started, [], provider.model);
      return {
        content:
          'I was unable to answer that. If it was a routine question about ARG’s figures, rephrasing it usually helps; otherwise the dashboards have the same numbers.',
        citations: [],
        activity,
        isRefusal: true,
      };
    }

    if (response.toolCalls.length === 0) {
      const text = response.text;
      await logTurn(db, input, 'assistant', text, false, Date.now() - started, citations, provider.model);

      return {
        content: text || 'I could not produce an answer for that.',
        citations,
        activity,
        view,
        pendingAction,
      };
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const tool = toolByName(call.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `No such tool: ${call.name}`,
          isError: true,
        });
        continue;
      }

      try {
        const outcome = await tool.run(call.input, context);

        if (outcome.activity) activity.push({ tool: tool.name, summary: outcome.activity });
        if (outcome.view) view = outcome.view;
        if (outcome.pendingAction) pendingAction = outcome.pendingAction;
        if (outcome.citations) citations.push(...outcome.citations);

        await db.insert(t.aiQueryLog).values({
          conversationId: input.conversationId,
          userId: input.user.id,
          role: 'tool',
          toolName: tool.name,
          toolInput: call.input as object,
          toolOutput: outcome.result as object,
          model: provider.model,
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(outcome.result),
        });
      } catch (error) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `The tool failed: ${error instanceof Error ? error.message : 'unknown error'}. Do not guess the figure — tell the user it could not be retrieved.`,
          isError: true,
        });
      }
    }
  }

  return {
    content:
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
  model = 'unknown',
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
