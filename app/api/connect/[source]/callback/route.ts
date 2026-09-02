import { NextResponse } from 'next/server';
import { and, eq, lt } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import {
  exchangeCode,
  fetchHubspotAccount,
  fetchQboCompanyName,
  getProvider,
} from '@/lib/connectors/oauth';
import { saveCredential } from '@/lib/connectors/credentials';
import {
  COMPOSIO_TOOLKITS,
  describeConnection,
  isActive,
  isComposioSource,
  waitForActive,
} from '@/lib/connectors/composio';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';

/**
 * Completes the OAuth round trip.
 *
 * Everything here is checked before a token is written: the state must exist,
 * must not have expired, and must belong to the person currently signed in.
 * A callback that fails any of those is discarded rather than repaired — the
 * cost of being wrong is a dashboard silently bound to the wrong company's
 * books, which would look like working software.
 */
export async function GET(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;
  const query = new URL(request.url).searchParams;

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  // The user declined at the provider, or the provider refused.
  const providerError = query.get('error');
  if (providerError) {
    return fail(
      request,
      `${sourceSystem} did not grant access: ${query.get('error_description') ?? providerError}`,
    );
  }

  // Composio's callback carries no authorisation code — it has already done the
  // exchange — so only the state is required at this point.
  const code = query.get('code');
  const state = query.get('state');
  if (!state) return fail(request, 'The callback was missing its state.');

  const db = await getDb();

  // Expired states are cleared opportunistically — this table would otherwise
  // accumulate a row for every abandoned connect attempt, forever.
  await db.delete(t.oauthState).where(lt(t.oauthState.expiresAt, new Date()));

  const [pending] = await db
    .select()
    .from(t.oauthState)
    .where(and(eq(t.oauthState.state, state), eq(t.oauthState.sourceSystem, sourceSystem)))
    .limit(1);

  if (!pending) {
    return fail(
      request,
      'That connection attempt is no longer valid — it expired or was already used. Start again.',
    );
  }

  // Single-use: delete before doing any work, so a replayed callback finds
  // nothing even if the exchange below is slow.
  await db.delete(t.oauthState).where(eq(t.oauthState.state, state));

  if (pending.userId !== user.id) {
    return fail(request, 'That connection was started by a different user. Start it again.');
  }

  // --- Composio -----------------------------------------------------------
  //
  // The connected-account id comes off the pending state row, never off the
  // query string. Composio does put one there, but trusting it would mean a
  // crafted callback could bind ARG's dashboard to a connection the attacker
  // owns — and the result would look exactly like a working connection.
  if (pending.composioConnectedAccountId) {
    if (!isComposioSource(sourceSystem)) {
      return fail(request, `${sourceSystem} does not sign in through Composio.`);
    }

    const status = query.get('status');
    if (status && status.toLowerCase() !== 'success') {
      return fail(
        request,
        `${COMPOSIO_TOOLKITS[sourceSystem].label} did not complete the sign-in (${status}). Nothing was saved.`,
      );
    }

    let account;
    try {
      account = await waitForActive(pending.composioConnectedAccountId);
    } catch (error) {
      return fail(
        request,
        `The connection could not be verified with Composio: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (!isActive(account)) {
      return fail(
        request,
        `${COMPOSIO_TOOLKITS[sourceSystem].label} reported the connection as ${account.status.toLowerCase()} ` +
          'rather than active, so nothing was saved. Try signing in again.',
      );
    }

    const identity = await describeConnection(sourceSystem, account);

    if (sourceSystem === 'QBO' && !identity.accountId) {
      return fail(
        request,
        'QuickBooks authorised, but the company id could not be established, so there is no way ' +
          'to tell which books this connection opens. Nothing was saved.',
      );
    }

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'COMPOSIO',
        // Nothing here is a secret. The token stays with Composio; this is the
        // handle that lets us ask Composio to use it.
        data: {
          connectedAccountId: account.id,
          toolkit: account.toolkitSlug ?? COMPOSIO_TOOLKITS[sourceSystem].slug,
          ...(identity.accountId ? { realmId: identity.accountId } : {}),
        },
        isReference: true,
        accountLabel: identity.accountLabel,
        accountId: identity.accountId,
        scopes: 'read-only, managed by Composio',
        connectedByUserId: user.id,
      },
      db,
    );

    await db.insert(t.auditEvent).values({
      userId: user.id,
      action: 'SOURCE_CONNECTED',
      entity: 'connector_credential',
      entityId: sourceSystem,
      detail: {
        authMethod: 'COMPOSIO',
        connectedAccountId: account.id,
        account: identity.accountLabel,
      },
    });

    const done = new URL(pending.redirectTo ?? '/admin', request.url);
    done.searchParams.set('connected', COMPOSIO_TOOLKITS[sourceSystem].label);
    return NextResponse.redirect(done);
  }

  // --- Direct OAuth -------------------------------------------------------
  const provider = getProvider(sourceSystem);
  if (!provider) return fail(request, `${sourceSystem} does not use OAuth.`);
  if (!code) return fail(request, 'The callback was missing its authorisation code.');

  let tokens;
  try {
    tokens = await exchangeCode(provider, code, request);
  } catch (error) {
    return fail(request, error instanceof Error ? error.message : 'The token exchange failed.');
  }

  if (!tokens.refresh_token) {
    return fail(
      request,
      `${provider.label} returned no refresh token, so the connection could not be made durable. ` +
        'Check that the app requests offline access.',
    );
  }

  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

  if (sourceSystem === 'QBO') {
    // Intuit puts the company id on the callback query string, not in the token
    // response. Without it we hold a valid token and cannot tell which books it
    // opens, so this is fatal rather than cosmetic.
    const realmId = query.get('realmId');
    if (!realmId) {
      return fail(
        request,
        'QuickBooks did not return a company id (realmId), so there is no way to tell which ' +
          'company this token opens. Nothing was saved.',
      );
    }

    const companyName = await fetchQboCompanyName(tokens.access_token, realmId);

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'OAUTH',
        data: {
          clientId: process.env[provider.clientIdEnv]!,
          clientSecret: process.env[provider.clientSecretEnv]!,
          refreshToken: tokens.refresh_token,
          realmId,
        },
        accountLabel: companyName ?? `Company ${realmId}`,
        accountId: realmId,
        scopes: tokens.scope ?? provider.scopes.join(' '),
        expiresAt,
        connectedByUserId: user.id,
      },
      db,
    );
  } else {
    const account = await fetchHubspotAccount(tokens.access_token);

    await saveCredential(
      {
        sourceSystem,
        authMethod: 'OAUTH',
        data: {
          clientId: process.env[provider.clientIdEnv]!,
          clientSecret: process.env[provider.clientSecretEnv]!,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
        },
        accountLabel: account?.label ?? provider.label,
        accountId: account?.portalId ?? null,
        scopes: tokens.scope ?? provider.scopes.join(' '),
        expiresAt,
        connectedByUserId: user.id,
      },
      db,
    );
  }

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'SOURCE_CONNECTED',
    entity: 'connector_credential',
    entityId: sourceSystem,
    detail: { authMethod: 'OAUTH', scopes: tokens.scope ?? provider.scopes.join(' ') },
  });

  const url = new URL(pending.redirectTo ?? '/admin', request.url);
  url.searchParams.set('connected', sourceSystem);
  return NextResponse.redirect(url);
}

function fail(request: Request, message: string) {
  const url = new URL('/admin', request.url);
  url.searchParams.set('connect_error', message);
  return NextResponse.redirect(url);
}
