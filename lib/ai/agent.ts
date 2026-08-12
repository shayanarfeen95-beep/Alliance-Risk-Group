import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import type { SemanticSession } from '@/lib/semantic/resolve';
import { AGENT_TOOLS, toolByName, type ToolContext } from './tools';
import { buildSystemPrompt, type PageContext } from './prompt';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * The agent loop.
 *
 * A manual tool-use loop rather than the SDK's tool runner: every tool call is
 * authorised and logged against the caller's entitlements before it runs, and
 * the loop needs the per-request semantic session in scope. Owning the loop
 * keeps that check in one place.
 */

const MODEL = process.env.ANTHROPIC_MODEL_INTERACTIVE ?? 'claude-opus-5';
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

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      'The assistant is not configured: ANTHROPIC_API_KEY is not set. Every dashboard still works — only the conversational layer is unavailable.',
    );
    this.name = 'AgentNotConfiguredError';
  }
}

export function isAgentConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  if (!isAgentConfigured()) throw new AgentNotConfiguredError();

  const client = new Anthropic();
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
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));

  const messages: Anthropic.MessageParam[] = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const activity: AgentTurnResult['activity'] = [];
  const citations: AgentCitation[] = [];
  let view: ChartCardProps | undefined;
  let pendingAction: AgentTurnResult['pendingAction'];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: buildSystemPrompt(input.user, input.session, input.pageContext),
      tools,
      messages,
    });

    // Safety classifiers can decline a request outright. That arrives as a
    // successful response with an empty or partial body, so check the stop
    // reason before reading content.
    if (response.stop_reason === 'refusal') {
      const detail = response.stop_details;
      await logTurn(db, input, 'assistant', 'Declined by safety classifier', true, Date.now() - started);
      return {
        content:
          'I was unable to answer that. If it was a routine question about ARG’s figures, rephrasing it usually helps; otherwise the dashboards have the same numbers.',
        citations: [],
        activity,
        isRefusal: true,
        ...(detail ? {} : {}),
      };
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      await logTurn(db, input, 'assistant', text, false, Date.now() - started, citations);

      return {
        content: text || 'I could not produce an answer for that.',
        citations,
        activity,
        view,
        pendingAction,
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    // All tool results go back in a single user message — splitting them
    // trains the model out of parallel calls.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const tool = toolByName(toolUse.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `No such tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      try {
        const outcome = await tool.run(
          (toolUse.input ?? {}) as Record<string, unknown>,
          context,
        );

        if (outcome.activity) activity.push({ tool: tool.name, summary: outcome.activity });
        if (outcome.view) view = outcome.view;
        if (outcome.pendingAction) pendingAction = outcome.pendingAction;
        if (outcome.citations) citations.push(...outcome.citations);

        await db.insert(t.aiQueryLog).values({
          conversationId: input.conversationId,
          userId: input.user.id,
          role: 'tool',
          toolName: tool.name,
          toolInput: (toolUse.input ?? {}) as object,
          toolOutput: outcome.result as object,
          model: MODEL,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(outcome.result),
        });
      } catch (error) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `The tool failed: ${error instanceof Error ? error.message : 'unknown error'}. Do not guess the figure — tell the user it could not be retrieved.`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
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
    model: MODEL,
    latencyMs,
  });
}
