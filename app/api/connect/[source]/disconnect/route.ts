import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { deleteCredential, loadCredential } from '@/lib/connectors/credentials';
import { deleteConnectedAccount } from '@/lib/connectors/composio';
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

  // Revoke at Composio too, so disconnecting here actually ends the grant rather
  // than leaving an authorised connection nobody is watching. A failure to
  // revoke must not block the local disconnect — the user asked for this source
  // to stop, and it stops either way.
  const existing = await loadCredential(sourceSystem, db);
  let revocationNote: string | null = null;
  if (existing?.authMethod === 'COMPOSIO' && existing.data.connectedAccountId) {
    try {
      await deleteConnectedAccount(existing.data.connectedAccountId);
    } catch (error) {
      revocationNote = error instanceof Error ? error.message : 'unknown error';
    }
  }

  await deleteCredential(sourceSystem, db);

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'SOURCE_DISCONNECTED',
    entity: 'connector_credential',
    entityId: sourceSystem,
    detail: {
      note: 'Credential removed. Previously loaded figures were left untouched.',
      ...(revocationNote ? { composioRevocationFailed: revocationNote } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    ...(revocationNote
      ? {
          warning:
            'Disconnected here, but Composio did not confirm the grant was revoked: ' +
            `${revocationNote}. Revoke it in the Composio dashboard to be certain.`,
        }
      : {}),
  });
}
