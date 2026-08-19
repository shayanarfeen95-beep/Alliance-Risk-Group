import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
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
  /** The thread this exchange belongs to, when the client is continuing one. */
  conversationId?: string | null;
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
    return NextResponse.json({ ok: false, error: 'Your session has expired. Sign in again.' }, { status: 401 });
  }

  if (!isAgentConfigured()) {
    return NextResponse.json({
      ok: false,
      error:
        'The assistant is not configured — ANTHROPIC_API_KEY is not set in this environment. Every dashboard and export still works; only the conversational layer is unavailable.',
    });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ ok: false, error: 'No message to answer.' }, { status: 400 });
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

  // The transcript survives navigation on the client, so the thread it belongs
  // to has to survive on the server too — otherwise the audit log records a
  // conversation as a dozen unrelated one-line exchanges. A supplied id is
  // honoured only when it belongs to this user.
  let conversation: { id: string } | undefined;

  if (body.conversationId) {
    const [existing] = await db
      .select({ id: t.agentConversation.id })
      .from(t.agentConversation)
      .where(
        and(
          eq(t.agentConversation.id, body.conversationId),
          eq(t.agentConversation.userId, user.id),
        ),
      )
      .limit(1);
    conversation = existing;
  }

  if (!conversation) {
    const [created] = await db
      .insert(t.agentConversation)
      .values({
        userId: user.id,
        title: body.messages[body.messages.length - 1]?.content.slice(0, 120) ?? null,
        pageContext: body.pageContext as object,
      })
      .returning();
    conversation = created;
  }

  await db.insert(t.aiQueryLog).values({
    conversationId: conversation!.id,
    userId: user.id,
    role: 'user',
    content: body.messages[body.messages.length - 1]?.content ?? '',
  });

  try {
    const result = await runAgentTurn({
      user,
      session,
      pageContext: body.pageContext ?? { page: 'executive' },
      messages: body.messages.slice(-20),
      conversationId: conversation!.id,
    });

    return NextResponse.json({
      ok: true,
      conversationId: conversation!.id,
      message: {
        role: 'assistant',
        content: result.content,
        citations: result.citations,
        activity: result.activity,
        links: result.links,
        view: result.view,
        verifyHref: result.verifyHref,
        isRefusal: result.isRefusal,
        pendingAction: result.pendingAction,
      },
    });
  } catch (error) {
    if (error instanceof AgentNotConfiguredError) {
      return NextResponse.json({ ok: false, error: error.message });
    }
    console.error('agent turn failed', error);
    return NextResponse.json({
      ok: false,
      error:
        error instanceof Error
          ? `The assistant could not complete that: ${error.message}`
          : 'The assistant could not complete that.',
    });
  }
}
