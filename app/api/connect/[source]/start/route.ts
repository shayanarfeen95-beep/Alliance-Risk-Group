import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { authorizeUrl, getProvider, isProviderConfigured, redirectUri } from '@/lib/connectors/oauth';
import { hasCredentialKey } from '@/lib/crypto/secrets';

export const dynamic = 'force-dynamic';

/**
 * Starts the OAuth round trip.
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

  const provider = getProvider(sourceSystem);
  if (!provider) return fail(request, `${sourceSystem} does not use OAuth.`);

  if (!isProviderConfigured(provider)) {
    return fail(
      request,
      `${provider.label} has no OAuth app configured. Set ${provider.clientIdEnv} and ` +
        `${provider.clientSecretEnv}, and register ${redirectUri(request, sourceSystem)} as the ` +
        `redirect URI in the ${provider.label} app.`,
    );
  }

  // Refusing here rather than after the round trip: the user would otherwise
  // authorise at Intuit, come back, and only then be told the token cannot be
  // stored — having granted access for nothing.
  if (!hasCredentialKey()) {
    return fail(
      request,
      'CREDENTIAL_KEY is not set, so the token could not be stored safely. Generate one with ' +
        '`openssl rand -base64 32` and set it in the environment, then connect again.',
    );
  }

  const state = randomBytes(32).toString('base64url');
  const db = await getDb();

  await db.insert(t.oauthState).values({
    state,
    sourceSystem,
    userId: user.id,
    redirectTo: '/admin',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  return NextResponse.redirect(authorizeUrl(provider, request, state));
}

function fail(request: Request, message: string) {
  const url = new URL('/admin', request.url);
  url.searchParams.set('connect_error', message);
  return NextResponse.redirect(url);
}
