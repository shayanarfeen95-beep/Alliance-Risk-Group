import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { deleteCredential } from '@/lib/connectors/credentials';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';

/**
 * Disconnects a source.
 *
 * Deletes the stored credential and nothing else. Figures already loaded from
 * that source stay exactly where they are: they are ARG's history, they were
 * reconciled when they landed, and deleting them because a token was revoked
 * would destroy closed months over an administrative action. What changes is
 * that the source stops refreshing — and every view already says when it was
 * last refreshed.
 */
export async function POST(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'EDIT_MAPPINGS')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can disconnect a source.' },
      { status: 403 },
    );
  }

  const db = await getDb();
  await deleteCredential(sourceSystem, db);

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'SOURCE_DISCONNECTED',
    entity: 'connector_credential',
    entityId: sourceSystem,
    detail: { note: 'Credential removed. Previously loaded figures were left untouched.' },
  });

  return NextResponse.json({ ok: true });
}
