/**
 * Chat history for the signed-in user.
 *
 * GET               → the user's recent chats, newest first.
 * GET ?thread=<id>  → one chat's questions and answers, in order.
 *
 * Built from the audit log every question and answer already lands in, so a
 * chat from before history existed is listed too (each of those questions is
 * its own chat). Only the asker's own chats are ever returned.
 */
import { NextResponse } from 'next/server';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });

  const db = await getDb();
  const thread = new URL(request.url).searchParams.get('thread');
  const threadKey = sql<string>`coalesce(${t.agentConversation.threadId}, ${t.agentConversation.id})`;

  if (thread) {
    if (!/^[0-9a-f-]{36}$/i.test(thread)) {
      return NextResponse.json({ ok: false, error: 'Unknown chat.' }, { status: 400 });
    }
    const conversations = await db
      .select({ id: t.agentConversation.id })
      .from(t.agentConversation)
      .where(and(eq(t.agentConversation.userId, user.id), sql`${threadKey} = ${thread}`));
    if (conversations.length === 0) {
      return NextResponse.json({ ok: false, error: 'Unknown chat.' }, { status: 404 });
    }
    const rows = await db
      .select({
        role: t.aiQueryLog.role,
        content: t.aiQueryLog.content,
        citations: t.aiQueryLog.citations,
        wasRefusal: t.aiQueryLog.wasRefusal,
        createdAt: t.aiQueryLog.createdAt,
      })
      .from(t.aiQueryLog)
      .where(
        and(
          inArray(
            t.aiQueryLog.conversationId,
            conversations.map((row) => row.id),
          ),
          inArray(t.aiQueryLog.role, ['user', 'assistant']),
        ),
      )
      .orderBy(asc(t.aiQueryLog.createdAt));
    return NextResponse.json({
      ok: true,
      threadId: thread,
      messages: rows
        .filter((row) => row.content?.trim())
        .map((row) => ({
          role: row.role,
          content: row.content,
          citations: row.citations ?? undefined,
          isRefusal: row.wasRefusal || undefined,
        })),
    });
  }

  const threads = await db
    .select({
      threadId: threadKey,
      title: sql<string>`(array_agg(${t.agentConversation.title} order by ${t.agentConversation.createdAt}))[1]`,
      questions: sql<number>`count(*)::int`,
      startedAt: sql<string>`min(${t.agentConversation.createdAt})`,
      lastAt: sql<string>`max(${t.agentConversation.createdAt})`,
    })
    .from(t.agentConversation)
    .where(eq(t.agentConversation.userId, user.id))
    .groupBy(threadKey)
    .orderBy(sql`max(${t.agentConversation.createdAt}) desc`)
    .limit(50);

  return NextResponse.json({ ok: true, threads });
}
