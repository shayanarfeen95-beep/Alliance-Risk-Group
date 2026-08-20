import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { hasCredentialKey } from '@/lib/crypto/secrets';
import {
  getComposioConnection,
  initiateComposioConnection,
  isComposioAvailable,
  saveComposioConnection,
} from '@/lib/connectors/composio';
import { redirectUri } from '@/lib/connectors/oauth';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';

/**
 * Starts a Composio-hosted connection, and finishes one.
 *
 * POST begins it and returns a URL to send the user to; PUT is called once they
 * come back, and stores the connection only if Composio reports it ACTIVE.
 *
 * The "only if ACTIVE" is the part worth having. Composio returns a connection
 * id the moment the flow starts, and storing that would mark the source as
 * connected while the user was still looking at Intuit's consent screen — or
 * after they closed it without approving. A source that says connected and is
 * not is worse than one that says nothing, because the failure surfaces at the
 * next refresh rather than now.
 */
export async function POST(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;

  const guard = await authorise();
  if (guard) return guard;

  if (!isComposioAvailable()) {
    return NextResponse.json({
      ok: false,
      error: 'COMPOSIO_API_KEY is not set, so Composio cannot be used to connect this source.',
    });
  }

  try {
    const connection = await initiateComposioConnection(
      sourceSystem,
      // Composio sends the user back here; the page then calls PUT to confirm.
      `${new URL(redirectUri(request, source)).origin}/admin?composio=${source.toLowerCase()}`,
    );

    if (!connection.redirectUrl) {
      return NextResponse.json({
        ok: false,
        error:
          'Composio started a connection but returned no authorisation URL, so there is nowhere ' +
          'to send you. Check the auth config for this toolkit in the Composio dashboard.',
      });
    }

    return NextResponse.json({
      ok: true,
      connectionId: connection.id,
      redirectUrl: connection.redirectUrl,
      status: connection.status,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Composio could not start a connection.',
    });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;

  const guard = await authorise();
  if (guard) return guard;

  const user = await getSessionUser();

  let body: { connectionId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  if (!body.connectionId) {
    return NextResponse.json({ ok: false, error: 'No connection was named.' }, { status: 400 });
  }

  try {
    const connection = await getComposioConnection(body.connectionId);

    if (connection.status !== 'ACTIVE') {
      return NextResponse.json({
        ok: false,
        status: connection.status,
        error:
          connection.status === 'INITIATED' || connection.status === 'INITIALIZING'
            ? 'The authorisation has not completed yet. Finish it in the window Composio opened, then try again.'
            : `Composio reports this connection as ${connection.status}. Nothing was saved.`,
      });
    }

    await saveComposioConnection(sourceSystem, connection, user!.id);

    const db = await getDb();
    await db.insert(t.auditEvent).values({
      userId: user!.id,
      action: 'SOURCE_CONNECTED',
      entity: 'connector_credential',
      entityId: sourceSystem,
      detail: { authMethod: 'OAUTH', via: 'composio', connectedAccountId: connection.id },
    });

    return NextResponse.json({ ok: true, status: connection.status });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Composio could not confirm the connection.',
    });
  }
}

async function authorise(): Promise<NextResponse | null> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'EDIT_MAPPINGS')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can connect a source.' },
      { status: 403 },
    );
  }
  if (!hasCredentialKey()) {
    return NextResponse.json({
      ok: false,
      error:
        'CREDENTIAL_KEY is not set, so the connection could not be stored safely. Generate one ' +
        'with `openssl rand -base64 32`.',
    });
  }
  return null;
}
