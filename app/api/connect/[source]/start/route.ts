import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { authorizeUrl, getProvider, isProviderConfigured, redirectUri } from '@/lib/connectors/oauth';
import {
  COMPOSIO_TOOLKITS,
  initiateConnection,
  isComposioConfigured,
  isComposioSource,
} from '@/lib/connectors/composio';
import { hasCredentialKey } from '@/lib/crypto/secrets';

export const dynamic = 'force-dynamic';

/**
 * Starts the sign-in.
 *
 * Two paths, and Composio is preferred whenever it is available, because it is
 * the one that asks the user for nothing but their QuickBooks password. The
 * direct OAuth path remains for a deployment that runs its own Intuit or HubSpot
 * application.
 *
 * The state parameter is random, single-use and stored server-side against the
 * user who began the flow. Without it, anyone could hand an administrator a
 * crafted callback URL and bind ARG's dashboard to *their* QuickBooks company —
 * the classic OAuth login-CSRF, and a particularly bad one here because the
 * result looks like a working connection showing someone else's books.
 */
export async function GET(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase();

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  if (!can(user, 'EDIT_MAPPINGS')) {
    return fail(request, 'Only an administrator or the CFO can connect a source.');
  }

  const db = await getDb();
  const state = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // --- Composio -----------------------------------------------------------
  if (isComposioConfigured() && isComposioSource(sourceSystem)) {
    const callbackUrl = `${callbackBase(request)}/api/connect/${source.toLowerCase()}/callback?state=${state}`;

    try {
      const connection = await initiateConnection({
        source: sourceSystem,
        userId: user.id,
        callbackUrl,
      });

      await db.insert(t.oauthState).values({
        state,
        sourceSystem,
        userId: user.id,
        redirectTo: '/admin',
        composioConnectedAccountId: connection.connectedAccountId,
        expiresAt,
      });

      // No redirect URL means the toolkit authorises without a round trip. The
      // callback still runs, so the connection is verified in one place.
      if (!connection.redirectUrl) return NextResponse.redirect(new URL(callbackUrl));

      return NextResponse.redirect(connection.redirectUrl);
    } catch (error) {
      return fail(
        request,
        `${COMPOSIO_TOOLKITS[sourceSystem].label} sign-in could not be started: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  // --- Direct OAuth -------------------------------------------------------
  const provider = getProvider(sourceSystem);
  if (!provider) {
    return fail(
      request,
      isComposioSource(sourceSystem)
        ? `${COMPOSIO_TOOLKITS[sourceSystem].label} signs in through Composio. Set COMPOSIO_API_KEY ` +
            'in the environment and the button will work — nothing else is needed.'
        : `${sourceSystem} has no sign-in flow.`,
    );
  }

  if (!isProviderConfigured(provider)) {
    return fail(
      request,
      `${provider.label} has no OAuth app configured. Set COMPOSIO_API_KEY to sign in without ` +
        `one, or set ${provider.clientIdEnv} and ${provider.clientSecretEnv} and register ` +
        `${redirectUri(request, sourceSystem)} as the redirect URI in the ${provider.label} app.`,
    );
  }

  // Refusing here rather than after the round trip: the user would otherwise
  // authorise at Intuit, come back, and only then be told the token cannot be
  // stored — having granted access for nothing.
  if (!hasCredentialKey()) {
    return fail(
      request,
      'CREDENTIAL_KEY is not set, so the token could not be stored safely. Generate one with ' +
        '`openssl rand -base64 32` and set it in the environment, then connect again. ' +
        '(Signing in through Composio needs no such key, because no token is held here.)',
    );
  }

  await db.insert(t.oauthState).values({
    state,
    sourceSystem,
    userId: user.id,
    redirectTo: '/admin',
    expiresAt,
  });

  return NextResponse.redirect(authorizeUrl(provider, request, state));
}

/**
 * The origin the provider will send the user back to.
 *
 * An explicit OAUTH_REDIRECT_BASE wins, because a deployment behind a proxy or a
 * custom domain cannot always read its own public address off the request.
 */
function callbackBase(request: Request): string {
  const configured = process.env.OAUTH_REDIRECT_BASE;
  return configured ? configured.replace(/\/$/, '') : new URL(request.url).origin;
}

function fail(request: Request, message: string) {
  const url = new URL('/admin', request.url);
  url.searchParams.set('connect_error', message);
  return NextResponse.redirect(url);
}
