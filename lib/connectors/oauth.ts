import type { SourceSystemCode } from './types';

/**
 * OAuth for the three sources.
 *
 * Each provider differs in ways that matter, and the differences are described
 * here rather than discovered during a failed connect:
 *
 *   - **QuickBooks** returns a `realmId` on the callback query string, not in
 *     the token response. Miss it and you hold a valid token with no idea which
 *     company it opens. Its refresh token also *rotates* on every use and
 *     expires after 100 days of disuse, so the new one must be written back
 *     every time or the connection dies quietly a few months later.
 *   - **HubSpot** issues refresh tokens that do not expire, and also supports a
 *     private-app token, which is a paste rather than a round trip. Both are
 *     offered because a private app is markedly simpler for a single portal.
 *   - **Google Sheets** is offered as a service account rather than OAuth. The
 *     data is a spreadsheet ARG owns; a service account with viewer access is
 *     less fragile than a user grant that breaks when that person leaves.
 *
 * Read-only scopes throughout. §2 Rule 7 says never modify source systems, and
 * requesting only read scopes means the token we hold *cannot* write, which is
 * a stronger guarantee than a connector that merely chooses not to.
 */

export interface OAuthProvider {
  sourceSystem: SourceSystemCode;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra params on the authorize request. */
  authorizeParams?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  QBO: {
    sourceSystem: 'QBO',
    label: 'QuickBooks Online',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    // Accounting is read/write as a single Intuit scope — there is no read-only
    // variant. The read-only guarantee is therefore held where it can be: no
    // connector in this codebase exposes a write method.
    scopes: ['com.intuit.quickbooks.accounting'],
    clientIdEnv: 'QBO_CLIENT_ID',
    clientSecretEnv: 'QBO_CLIENT_SECRET',
  },
  HUBSPOT: {
    sourceSystem: 'HUBSPOT',
    label: 'HubSpot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    // Exactly what the connector reads, and nothing more. Owners is needed for
    // the salesperson filter; meetings for Meetings Completed. Asking for a
    // scope the code never uses is a request ARG's admin has to evaluate on
    // trust rather than on evidence.
    scopes: [
      'crm.objects.deals.read',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.objects.owners.read',
      'crm.objects.meetings.read',
    ],
    clientIdEnv: 'HUBSPOT_CLIENT_ID',
    clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
  },
};

export function getProvider(sourceSystem: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[sourceSystem] ?? null;
}

export function isProviderConfigured(provider: OAuthProvider): boolean {
  return Boolean(process.env[provider.clientIdEnv] && process.env[provider.clientSecretEnv]);
}

/**
 * The callback URL registered with the provider.
 *
 * Derived from the incoming request rather than configured, so a preview
 * deployment and production both work without a second env var — but an
 * explicit OAUTH_REDIRECT_BASE wins, because the provider requires an exact
 * match and some deployments sit behind a domain the request does not reveal.
 */
export function redirectUri(request: Request, sourceSystem: string): string {
  const configured = process.env.OAUTH_REDIRECT_BASE;
  const base = configured
    ? configured.replace(/\/$/, '')
    : new URL(request.url).origin;
  return `${base}/api/connect/${sourceSystem.toLowerCase()}/callback`;
}

export function authorizeUrl(
  provider: OAuthProvider,
  request: Request,
  state: string,
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', process.env[provider.clientIdEnv]!);
  url.searchParams.set('redirect_uri', redirectUri(request, provider.sourceSystem));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(provider.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function postToken(provider: OAuthProvider, body: URLSearchParams): Promise<TokenResponse> {
  const credentials = Buffer.from(
    `${process.env[provider.clientIdEnv]}:${process.env[provider.clientSecretEnv]}`,
  ).toString('base64');

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${credentials}`,
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${provider.label} rejected the token request (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }

  return JSON.parse(text) as TokenResponse;
}

export function exchangeCode(
  provider: OAuthProvider,
  code: string,
  request: Request,
): Promise<TokenResponse> {
  return postToken(
    provider,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(request, provider.sourceSystem),
    }),
  );
}

export function refreshAccessToken(
  provider: OAuthProvider,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    provider,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/**
 * The QuickBooks company name, so the admin screen can say which set of books
 * is connected rather than showing a realm id nobody recognises.
 */
export async function fetchQboCompanyName(
  accessToken: string,
  realmId: string,
): Promise<string | null> {
  const base =
    process.env.QBO_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

  try {
    const response = await fetch(`${base}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { CompanyInfo?: { CompanyName?: string } };
    return body.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

/**
 * The HubSpot portal a token belongs to.
 *
 * Lives in `hubspot-verify.ts` with the scope probes, because asking "which
 * portal is this?" and asking "does this token work?" turned out to be
 * different questions: the portal name needs the `oauth` scope, and a private
 * app scoped for deals and contacts does not have it. Conflating them rejected
 * working tokens.
 */
export { fetchPortalDetails, verifyHubspotToken } from './hubspot-verify';
