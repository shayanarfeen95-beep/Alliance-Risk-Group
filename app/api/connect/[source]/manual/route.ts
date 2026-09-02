import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { loadCredential, saveCredential } from '@/lib/connectors/credentials';
import { readRange } from '@/lib/connectors/sheets';
import { fetchHubspotAccount } from '@/lib/connectors/oauth';
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
  let body: Record<string, string>;
  try {
    body = (await request.json()) as Record<string, string>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const db = await getDb();
  const existing = await loadCredential(sourceSystem, db);

  // --- Naming the spreadsheet on an account already signed in ---------------
  //
  // Google grants access to an account, not to a document, so a signed-in Sheets
  // connection still needs to be told which spreadsheet holds the budget. This
  // is a document identifier, not a credential — pasting a link is the whole
  // step, and nothing here asks for a key.
  if (sourceSystem === 'SHEETS' && existing?.authMethod === 'COMPOSIO') {
    const spreadsheetId = extractSpreadsheetId(body.spreadsheetId ?? '');
    if (!spreadsheetId) {
      return NextResponse.json({
        ok: false,
        error: 'Paste the spreadsheet link, or its id. Nothing was saved.',
      });
    }

    const range = process.env.SHEETS_RANGE_MONTHLY_BUDGET ?? 'Monthly Budget!A1:Z200';
    try {
      await readRange(spreadsheetId, range);
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error:
          `That spreadsheet could not be read as ${existing.accountLabel ?? 'the signed-in account'}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}. Check the link, and that ` +
          `the signed-in Google account can open it. Nothing was saved.`,
      });
    }

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'COMPOSIO',
        data: { ...existing.data, spreadsheetId },
        isReference: true,
        accountLabel: existing.accountLabel,
        accountId: spreadsheetId,
        scopes: existing.scopes,
        connectedByUserId: user.id,
      },
      db,
    );

    await db.insert(t.auditEvent).values({
      userId: user.id,
      action: 'SOURCE_CONNECTED',
      entity: 'connector_credential',
      entityId: sourceSystem,
      detail: { authMethod: 'COMPOSIO', spreadsheetId },
    });

    return NextResponse.json({ ok: true });
  }

  if (!hasCredentialKey()) {
    return NextResponse.json({
      ok: false,
      error:
        'CREDENTIAL_KEY is not set, so the credential could not be stored safely. Generate one ' +
        'with `openssl rand -base64 32` and set it in the environment — or set COMPOSIO_API_KEY ' +
        'and sign in instead, which stores no secret at all.',
    });
  }

  if (sourceSystem === 'HUBSPOT') {
    const token = (body.accessToken ?? '').trim();
    if (!token) return NextResponse.json({ ok: false, error: 'A private-app token is required.' });

    const account = await fetchHubspotAccount(token);
    if (!account) {
      return NextResponse.json({
        ok: false,
        error:
          'HubSpot rejected that token, or it lacks the account-info scope. Nothing was saved. ' +
          'The private app needs the deals, contacts and companies read scopes.',
      });
    }

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'TOKEN',
        data: { accessToken: token },
        accountLabel: account.label,
        accountId: account.portalId,
        scopes: 'private app',
        connectedByUserId: user.id,
      },
      db,
    );
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

/**
 * Accepts what a person actually has to hand.
 *
 * Nobody keeps spreadsheet ids; they keep the URL in the address bar. Asking for
 * the id and rejecting the link would be a small, avoidable piece of friction in
 * the one step of this flow that still needs typing.
 */
function extractSpreadsheetId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const fromUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl?.[1]) return fromUrl[1];

  return /^[a-zA-Z0-9-_]{20,}$/.test(value) ? value : null;
}
