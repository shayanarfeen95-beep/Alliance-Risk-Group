import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { openSemanticSession } from '@/lib/semantic/resolve';
import { runAgentTurn, isAgentConfigured, AgentNotConfiguredError } from '@/lib/ai/agent';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface RequestBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  pageContext: { page: string; month?: string; division?: string };
}

/**
 * An error, in the same shape as everything else on this route.
 *
 * The guards below used to return plain JSON, which was right when the success
 * path did too. Once the answer became a stream, a plain `{ok:false}` body
 * parsed as one NDJSON line with no `type` field — so the client ignored it and
 * the send failed silently, with no message and no spinner. Every exit from
 * this route now speaks the same protocol.
 */
function streamError(error: string, status = 200): Response {
  return new Response(`${JSON.stringify({ type: 'error', error })}\n`, {
    status,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function normaliseMonth(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return streamError('Your session has expired. Sign in again.', 401);
  }

  if (!isAgentConfigured()) {
    return streamError(
      'The assistant is not configured — OPENROUTER_API_KEY is not set in this environment. ' +
        'Every dashboard and export still works; only the conversational layer is unavailable.',
    );
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return streamError('Malformed request.', 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return streamError('No message to answer.', 400);
  }

  const db = await getDb();

  // Resolve the reporting month the user is actually looking at, falling back
  // to the configured default rather than guessing.
  const [defaultMonth] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const month =
    normaliseMonth(body.pageContext?.month) ?? defaultMonth?.value ?? '2026-03-01';

  const session = await openSemanticSession(db, user, month);

  // One conversation row per exchange keeps the audit log navigable.
  const [conversation] = await db
    .insert(t.agentConversation)
    .values({
      userId: user.id,
      title: body.messages[body.messages.length - 1]?.content.slice(0, 120) ?? null,
      pageContext: body.pageContext as object,
    })
    .returning();

  await db.insert(t.aiQueryLog).values({
    conversationId: conversation!.id,
    userId: user.id,
    role: 'user',
    content: body.messages[body.messages.length - 1]?.content ?? '',
  });

  /**
   * Streamed as newline-delimited JSON rather than returned whole.
   *
   * A question needing four figures is four tool calls with model turns
   * between them, and the whole thing can take the better part of a minute on
   * a free model. Returning only at the end means the panel shows one
   * unchanging "Working…" for all of it, which reads as a hang — and the steps
   * are worth seeing anyway, because "read Revenue · CLAIMS · March 2026" is
   * the assistant showing its work.
   *
   * Each line is a complete JSON object, so the client parses on newlines and
   * never has to reassemble a partial value.
   */
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await runAgentTurn({
          user,
          session,
          pageContext: body.pageContext ?? { page: 'executive' },
          messages: body.messages.slice(-20),
          conversationId: conversation!.id,
          onActivity: (activity) => send({ type: 'activity', activity }),
          signal: request.signal,
        });

        send({
          type: 'message',
          message: {
            role: 'assistant',
            content: result.content,
            citations: result.citations,
            activity: result.activity,
            view: result.view,
            verifyHref: result.verifyHref,
            isRefusal: result.isRefusal,
            pendingAction: result.pendingAction,
          },
        });
      } catch (error) {
        if (error instanceof AgentNotConfiguredError) {
          send({ type: 'error', error: error.message });
        } else {
          console.error('agent turn failed', error);
          send({
            type: 'error',
            error:
              error instanceof Error
                ? `The assistant could not complete that: ${error.message}`
                : 'The assistant could not complete that.',
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Proxies that buffer would defeat the point of streaming at all.
      'x-accel-buffering': 'no',
    },
  });
}
