import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { saveCredential } from '@/lib/connectors/credentials';
import { verifyHubspotToken } from '@/lib/connectors/hubspot-verify';
import { hasCredentialKey } from '@/lib/crypto/secrets';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';

/**
 * Connects a source by pasted credential rather than a round trip.
 *
 * Two of the three sources are better served this way. A HubSpot private app is
 * a single token scoped to one portal — simpler than registering an OAuth app
 * for a system with one tenant. Google Sheets uses a service account because the
 * spreadsheet belongs to ARG: a service account with viewer access keeps working
 * when the person who authorised it leaves, and a user grant does not.
 *
 * Every credential is verified against the provider before it is stored. A
 * connection that says "connected" and fails at the next refresh is worse than
 * one that refuses immediately, because the failure surfaces at 3am rather than
 * while somebody is looking at the screen.
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
      { ok: false, error: 'Only an administrator or the CFO can connect a source.' },
      { status: 403 },
    );
  }
  if (!hasCredentialKey()) {
    return NextResponse.json({
      ok: false,
      error:
        'CREDENTIAL_KEY is not set, so the credential could not be stored safely. Generate one ' +
        'with `openssl rand -base64 32` and set it in the environment.',
    });
  }

  let body: Record<string, string>;
  try {
    body = (await request.json()) as Record<string, string>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const db = await getDb();

  if (sourceSystem === 'HUBSPOT') {
    const token = (body.accessToken ?? '').trim();
    if (!token) return NextResponse.json({ ok: false, error: 'A private-app token is required.' });

    // Probes the endpoints the connector will actually read, scope by scope.
    // The earlier version asked /account-info/v3/details, which needs the
    // `oauth` scope a private app built for deals and contacts does not have —
    // so it answered 403 and reported a working token as rejected.
    const check = await verifyHubspotToken(token);
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: `${check.error} Nothing was saved.` });
    }

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'TOKEN',
        data: { accessToken: token },
        accountLabel: check.label,
        accountId: check.portalId,
        // The scopes actually proven, not the ones we hoped for. The admin
        // screen reads this, and it is the first thing to look at when a KPI
        // reports unavailable.
        scopes: check.scopes
          .filter((scope) => scope.granted)
          .map((scope) => scope.scope)
          .join(' '),
        connectedByUserId: user.id,
      },
      db,
    );

    if (check.warnings.length > 0) {
      // Connected, but not completely. Saying so here is the difference between
      // a metric that reads "unavailable" for a knowable reason and one that
      // reads "unavailable" and sends somebody through the whole stack.
      await db.insert(t.auditEvent).values({
        userId: user.id,
        action: 'SOURCE_CONNECTED',
        entity: 'connector_credential',
        entityId: sourceSystem,
        detail: { authMethod: 'TOKEN', warnings: check.warnings },
      });
      return NextResponse.json({ ok: true, warnings: check.warnings });
    }
  } else if (sourceSystem === 'SHEETS') {
    const spreadsheetId = (body.spreadsheetId ?? '').trim();
    const raw = (body.serviceAccountJson ?? '').trim();
    if (!spreadsheetId || !raw) {
      return NextResponse.json({
        ok: false,
        error: 'Both the service-account JSON and the spreadsheet id are required.',
      });
    }

    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return NextResponse.json({
        ok: false,
        error: 'That is not valid JSON. Paste the whole key file Google gave you.',
      });
    }

    if (!parsed.client_email || !parsed.private_key) {
      return NextResponse.json({
        ok: false,
        error:
          'The JSON is missing client_email or private_key, so it is not a service-account key file.',
      });
    }

    const check = await verifySheetAccess(parsed.client_email, parsed.private_key, spreadsheetId);
    if (!check.ok) return NextResponse.json({ ok: false, error: check.error });

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'SERVICE_ACCOUNT',
        data: {
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
          spreadsheetId,
        },
        accountLabel: check.title ? `${check.title} · ${parsed.client_email}` : parsed.client_email,
        accountId: spreadsheetId,
        scopes: 'spreadsheets.readonly',
        connectedByUserId: user.id,
      },
      db,
    );
  } else {
    return NextResponse.json({
      ok: false,
      error: `${sourceSystem} is connected through its authorisation flow, not by pasting a token.`,
    });
  }

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'SOURCE_CONNECTED',
    entity: 'connector_credential',
    entityId: sourceSystem,
    detail: { authMethod: sourceSystem === 'HUBSPOT' ? 'TOKEN' : 'SERVICE_ACCOUNT' },
  });

  return NextResponse.json({ ok: true });
}

/**
 * Proves the service account can actually read the sheet.
 *
 * Sharing the spreadsheet with the service-account address is a separate manual
 * step that is very easy to forget, and forgetting it produces a 403 at the next
 * refresh rather than here. So the check is a real read.
 */
async function verifySheetAccess(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
): Promise<{ ok: true; title: string | null } | { ok: false; error: string }> {
  const { signJwtAssertion } = await import('@/lib/connectors/google-auth');

  let accessToken: string;
  try {
    accessToken = await signJwtAssertion(clientEmail, privateKey.replace(/\\n/g, '\n'));
  } catch (error) {
    return {
      ok: false,
      error: `Google rejected the key: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  if (response.status === 403 || response.status === 404) {
    return {
      ok: false,
      error:
        `The service account cannot open that spreadsheet. Share it with ${clientEmail} ` +
        '(Viewer is enough), then try again. Nothing was saved.',
    };
  }
  if (!response.ok) {
    return { ok: false, error: `Google returned HTTP ${response.status}. Nothing was saved.` };
  }

  const body = (await response.json()) as { properties?: { title?: string } };
  return { ok: true, title: body.properties?.title ?? null };
}
