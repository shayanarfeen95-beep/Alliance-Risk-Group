import 'server-only';

/**
 * Composio — the connection broker.
 *
 * Before this, connecting QuickBooks meant registering an Intuit developer app,
 * pasting a client id and secret into the environment, redeploying, and only
 * then clicking Connect. HubSpot meant creating a private app and pasting its
 * token. Google Sheets meant downloading a service-account key file and sharing
 * a spreadsheet with a robot's email address. Three different rituals, all of
 * them performed by whoever has the most patience, none of them repeatable.
 *
 * Composio removes all of it. It holds the OAuth apps, runs the consent round
 * trip, stores the tokens, and refreshes them. What this application keeps is an
 * identifier — `ca_…` — which is not a secret and opens nothing on its own.
 *
 * Two consequences worth stating plainly, because they change how the rest of
 * the connector code is written:
 *
 *   1. **We never hold a provider token.** Composio redacts credentials in every
 *      API response by design. So requests to QuickBooks and HubSpot go *through*
 *      Composio's proxy, which injects the credential server-side. There is no
 *      code path in this repository that could leak ARG's accounting token,
 *      because no code path ever receives one.
 *   2. **CREDENTIAL_KEY becomes optional.** It exists to encrypt tokens at rest.
 *      With nothing secret to store, a Composio connection is recorded as a plain
 *      reference and connecting no longer depends on an encryption key having
 *      been configured first.
 *
 * Read-only remains enforced the way it always was: no function here writes to a
 * source system, and the connectors expose no method that could.
 */

const DEFAULT_BASE_URL = 'https://backend.composio.dev/api/v3';

/** Composio's toolkit for each of our source systems. */
export const COMPOSIO_TOOLKITS = {
  QBO: { slug: 'quickbooks', label: 'QuickBooks', signIn: 'Sign in with QuickBooks' },
  HUBSPOT: { slug: 'hubspot', label: 'HubSpot', signIn: 'Sign in with HubSpot' },
  SHEETS: { slug: 'googlesheets', label: 'Google Sheets', signIn: 'Sign in with Google' },
} as const;

export type ComposioSource = keyof typeof COMPOSIO_TOOLKITS;

export function isComposioSource(value: string): value is ComposioSource {
  return value in COMPOSIO_TOOLKITS;
}

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

function baseUrl(): string {
  return (process.env.COMPOSIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

export class ComposioNotConfiguredError extends Error {
  constructor() {
    super(
      'COMPOSIO_API_KEY is not set, so one-click sign-in is unavailable. Add it to the ' +
        'environment — it is the only variable the source connections need.',
    );
    this.name = 'ComposioNotConfiguredError';
  }
}

export class ComposioError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Composio ${path} failed with HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'ComposioError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isComposioConfigured()) throw new ComposioNotConfiguredError();

  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      'x-api-key': process.env.COMPOSIO_API_KEY!,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  const text = await response.text();
  if (!response.ok) throw new ComposioError(response.status, path, text);
  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ComposioError(response.status, path, `response was not JSON: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Auth configs
// ---------------------------------------------------------------------------

/**
 * Composio's response shapes differ between snake_case and camelCase depending
 * on the surface, and have changed across versions. Reading both spellings
 * everywhere is three characters of defensiveness that avoids a connection that
 * silently reports success with an undefined id.
 */
function pick<T>(source: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

interface AuthConfigRecord {
  id?: string;
  nanoid?: string;
  toolkit?: { slug?: string };
  auth_config?: { id?: string };
  authConfig?: { id?: string };
}

const authConfigCache = new Map<string, string>();

/**
 * The auth config for a toolkit, creating one on first use.
 *
 * An auth config is Composio's word for "which OAuth app authorises this
 * toolkit". Using Composio's managed app means ARG never registers an Intuit or
 * HubSpot developer application at all — which is the entire point of this path.
 * If an operator later wants ARG's own branded OAuth app, they create the auth
 * config in Composio's dashboard and this function finds and reuses it rather
 * than making a second one.
 */
export async function ensureAuthConfig(source: ComposioSource): Promise<string> {
  const { slug } = COMPOSIO_TOOLKITS[source];
  const cached = authConfigCache.get(slug);
  if (cached) return cached;

  type AuthConfigList = { items?: AuthConfigRecord[]; data?: AuthConfigRecord[] };
  const existing: AuthConfigList = await call<AuthConfigList>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=50`,
  ).catch(() => ({}));

  const list = existing.items ?? existing.data ?? [];
  const match = list.find(
    (item) => (item.toolkit?.slug ?? '').toLowerCase() === slug.toLowerCase(),
  );
  const existingId = match?.id ?? match?.nanoid;
  if (existingId) {
    authConfigCache.set(slug, existingId);
    return existingId;
  }

  const created = await call<AuthConfigRecord>('/auth_configs', {
    method: 'POST',
    body: JSON.stringify({
      toolkit: { slug },
      auth_config: { type: 'use_composio_managed_auth' },
    }),
  });

  const id =
    created.auth_config?.id ?? created.authConfig?.id ?? created.id ?? created.nanoid;
  if (!id) {
    throw new Error(
      `Composio created an auth config for ${slug} but returned no id, so the sign-in could not be started.`,
    );
  }

  authConfigCache.set(slug, id);
  return id;
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

export interface ConnectionRequest {
  connectedAccountId: string;
  redirectUrl: string | null;
}

/**
 * Starts the sign-in.
 *
 * `userId` is ARG's own user id, passed straight through. Composio scopes the
 * connection to it, so the audit question "who connected these books" has an
 * answer on both sides of the boundary.
 */
export async function initiateConnection(input: {
  source: ComposioSource;
  userId: string;
  callbackUrl: string;
}): Promise<ConnectionRequest> {
  const authConfigId = await ensureAuthConfig(input.source);

  const created = await call<Record<string, unknown>>('/connected_accounts', {
    method: 'POST',
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: {
        user_id: input.userId,
        callback_url: input.callbackUrl,
        state: { authScheme: 'OAUTH2', val: { status: 'INITIATED' } },
      },
    }),
  });

  const connectedAccountId =
    pick<string>(created, 'id', 'nanoid', 'connected_account_id', 'connectedAccountId') ??
    pick<string>(
      created.connectedAccount as Record<string, unknown> | undefined,
      'id',
      'nanoid',
    );

  if (!connectedAccountId) {
    throw new Error(
      'Composio started the connection but returned no connected-account id, so the callback ' +
        'could not be matched to it. Nothing was saved.',
    );
  }

  const redirectUrl =
    pick<string>(created, 'redirect_url', 'redirectUrl', 'redirect_uri', 'redirectUri') ?? null;

  return { connectedAccountId, redirectUrl };
}

export interface ConnectedAccount {
  id: string;
  status: string;
  toolkitSlug: string | null;
  /** Non-secret identifiers the provider returned — the QuickBooks realm, say. */
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export async function getConnectedAccount(id: string): Promise<ConnectedAccount> {
  const raw = await call<Record<string, unknown>>(`/connected_accounts/${encodeURIComponent(id)}`);

  const toolkit = raw.toolkit as Record<string, unknown> | undefined;
  const state = (raw.state ?? raw.connectionData) as Record<string, unknown> | undefined;
  const val = (state?.val ?? {}) as Record<string, unknown>;

  return {
    id: pick<string>(raw, 'id', 'nanoid') ?? id,
    status: String(pick<string>(raw, 'status', 'connectionStatus') ?? 'UNKNOWN').toUpperCase(),
    toolkitSlug: pick<string>(toolkit, 'slug') ?? pick<string>(raw, 'toolkit_slug') ?? null,
    // Tokens are redacted by Composio; what survives is the non-secret context —
    // account ids, portal ids, the QuickBooks realm — which is exactly what the
    // connectors need to address the right company.
    metadata: {
      ...(raw.params as Record<string, unknown> | undefined),
      ...(raw.metadata as Record<string, unknown> | undefined),
      ...val,
    },
    createdAt: pick<string>(raw, 'created_at', 'createdAt') ?? null,
  };
}

export async function deleteConnectedAccount(id: string): Promise<void> {
  await call(`/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** ACTIVE is the only state in which a connector may claim to be connected. */
export function isActive(account: ConnectedAccount): boolean {
  return account.status === 'ACTIVE';
}

// ---------------------------------------------------------------------------
// Calling the provider
// ---------------------------------------------------------------------------

export interface ProxyParameter {
  name: string;
  value: string;
  /** Composio has used both spellings; both are sent. */
  in: 'header' | 'query';
}

/**
 * An authenticated request to the provider's own API.
 *
 * This is why the connectors keep their existing shape. QuickBooks' report API
 * takes `summarize_column_by=Classes`, which is the parameter that produces a
 * division dimension, and no packaged tool exposes it. Proxying the real request
 * keeps ARG's figures coming from the same endpoints a QuickBooks user would
 * check them against, while Composio supplies the credential.
 */
export async function proxy<T>(input: {
  connectedAccountId: string;
  endpoint: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<T> {
  const parameters: Array<Record<string, string>> = [];

  for (const [name, value] of Object.entries(input.query ?? {})) {
    parameters.push({ name, value, in: 'query', type: 'query' });
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    parameters.push({ name, value, in: 'header', type: 'header' });
  }

  const response = await call<Record<string, unknown>>('/tools/execute/proxy', {
    method: 'POST',
    body: JSON.stringify({
      connected_account_id: input.connectedAccountId,
      connectedAccountId: input.connectedAccountId,
      endpoint: input.endpoint,
      method: input.method ?? 'GET',
      parameters,
      ...(input.body === undefined ? {} : { body: input.body }),
    }),
  });

  return unwrap<T>(response, input.endpoint);
}

/**
 * A packaged Composio tool.
 *
 * Used where a tool knows something the raw API does not make easy — the
 * QuickBooks company id being the case that matters here.
 */
export async function executeTool<T>(
  slug: string,
  input: { connectedAccountId?: string; userId?: string; arguments?: Record<string, unknown> },
): Promise<T> {
  const response = await call<Record<string, unknown>>(
    `/tools/execute/${encodeURIComponent(slug)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(input.connectedAccountId
          ? { connected_account_id: input.connectedAccountId, connectedAccountId: input.connectedAccountId }
          : {}),
        ...(input.userId ? { user_id: input.userId, userId: input.userId } : {}),
        arguments: input.arguments ?? {},
        allow_tracing: false,
      }),
    },
  );

  return unwrap<T>(response, slug);
}

/**
 * Composio wraps results as `{ successful, data, error }` and has also returned
 * `successfull` (its own long-standing typo) and a bare payload. A failed call
 * that returns HTTP 200 with `successful: false` is the dangerous case: read
 * naively it looks like an empty report, and an empty report loaded into the
 * warehouse is a month of zeroes that nobody questions.
 */
function unwrap<T>(response: Record<string, unknown>, what: string): T {
  const successful = response.successful ?? response.successfull ?? response.success;

  if (successful === false) {
    const error =
      (response.error as string | undefined) ??
      (response.message as string | undefined) ??
      'no reason given';
    throw new Error(`Composio could not complete ${what}: ${error}`);
  }

  const data = (response.data ?? response.response_data ?? response) as Record<string, unknown>;

  // The proxy nests the provider's own body one level deeper.
  if (data && typeof data === 'object' && 'data' in data && Object.keys(data).length <= 3) {
    const inner = (data as { data?: unknown }).data;
    if (inner && typeof inner === 'object') return inner as T;
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Naming the thing that was connected
// ---------------------------------------------------------------------------

export interface ConnectionIdentity {
  /** What the admin screen shows: the company, the portal, the account. */
  accountLabel: string | null;
  /**
   * The provider-side identifier the connectors need to address the right data.
   * For QuickBooks this is the realm id, and it is not optional: without it
   * there is no way to tell which company's books a connection opens.
   */
  accountId: string | null;
}

/** Scans Composio's non-secret connection metadata for a known key. */
function metadataValue(
  metadata: Record<string, unknown>,
  ...candidates: string[]
): string | null {
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(metadata)) {
      if (key.toLowerCase() !== candidate.toLowerCase()) continue;
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
  }
  return null;
}

/**
 * Establishes which company, portal or account a connection actually opens.
 *
 * Asked once, at connect time, and stored — so the admin screen names the books
 * rather than showing an opaque `ca_…`, and every later request has the realm id
 * it needs without another round trip.
 *
 * For QuickBooks the realm is looked for in Composio's connection metadata
 * first, and asked of QuickBooks itself if it is not there. A connection whose
 * realm cannot be established is reported as a failure rather than saved: a
 * connector that does not know whose books it is reading is worse than no
 * connector at all.
 */
export async function describeConnection(
  source: ComposioSource,
  account: ConnectedAccount,
): Promise<ConnectionIdentity> {
  if (source === 'QBO') {
    const realm =
      metadataValue(account.metadata, 'realmId', 'realm_id', 'companyId', 'company_id') ??
      process.env.QBO_REALM_ID ??
      null;

    let companyName: string | null = null;
    let resolvedRealm = realm;

    try {
      const info = await executeTool<Record<string, unknown>>('QUICKBOOKS_GET_COMPANY_INFO', {
        connectedAccountId: account.id,
      });
      const company = ((info.CompanyInfo ?? info.companyInfo ?? info) ?? {}) as Record<string, unknown>;
      const name = company.CompanyName ?? company.companyName;
      if (typeof name === 'string' && name.trim()) companyName = name.trim();
      const id = company.Id ?? company.id ?? company.realmId;
      if (!resolvedRealm && (typeof id === 'string' || typeof id === 'number')) {
        resolvedRealm = String(id);
      }
    } catch {
      // Company info is a convenience for the label; a missing realm is handled
      // by the caller, which is the thing that actually matters.
    }

    return {
      accountLabel: companyName ?? (resolvedRealm ? `Company ${resolvedRealm}` : null),
      accountId: resolvedRealm,
    };
  }

  if (source === 'HUBSPOT') {
    const portalId = metadataValue(account.metadata, 'portalId', 'portal_id', 'hub_id', 'hubId');
    return {
      accountLabel: portalId ? `Portal ${portalId}` : 'HubSpot portal',
      accountId: portalId,
    };
  }

  const email = metadataValue(account.metadata, 'email', 'user_email', 'account_email');
  return { accountLabel: email ?? 'Google account', accountId: email };
}

/**
 * Waits for a freshly authorised connection to become ACTIVE.
 *
 * Composio finishes the token exchange after redirecting the user back, so the
 * first read is often still INITIATED. Polling briefly here means the admin
 * screen shows "Connected" on the page the user lands on, rather than showing a
 * failure that would have resolved itself a second later.
 */
export async function waitForActive(
  connectedAccountId: string,
  attempts = 6,
): Promise<ConnectedAccount> {
  let latest = await getConnectedAccount(connectedAccountId);

  for (let attempt = 1; attempt < attempts && !isActive(latest); attempt++) {
    if (latest.status === 'FAILED' || latest.status === 'EXPIRED') break;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    latest = await getConnectedAccount(connectedAccountId);
  }

  return latest;
}
