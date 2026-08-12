import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { getDb, type Database } from '@/lib/db/client';
import { decryptSecret, encryptSecret, hasCredentialKey } from '@/lib/crypto/secrets';
import type { SourceSystemCode } from './types';

/**
 * Where a connector's credentials come from.
 *
 * Two sources, checked in this order:
 *
 *   1. The database, written by the Connect flow in Admin. This is the path a
 *      person uses — click Connect, authorise at Intuit, done.
 *   2. The environment, for a deployment that would rather manage secrets
 *      itself, and for local development.
 *
 * The database wins because it is the one a user can change without a redeploy.
 * The environment remains supported because a locked-down deployment may forbid
 * storing third-party tokens in its own database, and that is a legitimate
 * position rather than a misconfiguration.
 */

export type AuthMethod = 'OAUTH' | 'TOKEN' | 'SERVICE_ACCOUNT';

export interface StoredCredential {
  sourceSystem: SourceSystemCode;
  authMethod: AuthMethod;
  /** Decrypted payload. Shape depends on the source. */
  data: Record<string, string>;
  accountLabel: string | null;
  accountId: string | null;
  scopes: string | null;
  expiresAt: Date | null;
  status: string;
  origin: 'database' | 'environment';
}

export interface CredentialSummary {
  sourceSystem: SourceSystemCode;
  connected: boolean;
  origin: 'database' | 'environment' | null;
  authMethod: AuthMethod | null;
  accountLabel: string | null;
  accountId: string | null;
  scopes: string | null;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

// ---------------------------------------------------------------------------
// Environment fallbacks
// ---------------------------------------------------------------------------

/**
 * Credentials assembled from environment variables.
 *
 * Returns null unless every field a source actually needs is present. A
 * half-configured source must report as not connected — a connector that
 * believes it is configured and then fails mid-refresh is harder to diagnose
 * than one that says up front that it is not.
 */
function fromEnvironment(sourceSystem: SourceSystemCode): StoredCredential | null {
  const base = {
    sourceSystem,
    accountLabel: null,
    accountId: null,
    scopes: null,
    expiresAt: null,
    status: 'CONNECTED',
    origin: 'environment' as const,
  };

  if (sourceSystem === 'QBO') {
    const { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID } = process.env;
    if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REFRESH_TOKEN || !QBO_REALM_ID) return null;
    return {
      ...base,
      authMethod: 'OAUTH',
      accountId: QBO_REALM_ID,
      data: {
        clientId: QBO_CLIENT_ID,
        clientSecret: QBO_CLIENT_SECRET,
        refreshToken: QBO_REFRESH_TOKEN,
        realmId: QBO_REALM_ID,
      },
    };
  }

  if (sourceSystem === 'HUBSPOT') {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) return null;
    return { ...base, authMethod: 'TOKEN', data: { accessToken: token } };
  }

  if (sourceSystem === 'SHEETS') {
    const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_BUDGET_SPREADSHEET_ID } =
      process.env;
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_BUDGET_SPREADSHEET_ID) {
      return null;
    }
    return {
      ...base,
      authMethod: 'SERVICE_ACCOUNT',
      accountId: GOOGLE_BUDGET_SPREADSHEET_ID,
      accountLabel: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      data: {
        clientEmail: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        privateKey: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        spreadsheetId: GOOGLE_BUDGET_SPREADSHEET_ID,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadCredential(
  sourceSystem: SourceSystemCode,
  db?: Database,
): Promise<StoredCredential | null> {
  // The credential table only exists once migrations have run, and a source
  // asked about before then is simply not connected — not an error worth
  // failing a page render over.
  try {
    const database = db ?? (await getDb());
    const [row] = await database
      .select()
      .from(t.connectorCredential)
      .where(eq(t.connectorCredential.sourceSystem, sourceSystem))
      .limit(1);

    if (row && hasCredentialKey()) {
      return {
        sourceSystem,
        authMethod: row.authMethod as AuthMethod,
        data: JSON.parse(decryptSecret(row.secret)) as Record<string, string>,
        accountLabel: row.accountLabel,
        accountId: row.accountId,
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        status: row.status,
        origin: 'database',
      };
    }
  } catch {
    // Fall through to the environment.
  }

  return fromEnvironment(sourceSystem);
}

export async function isConnected(sourceSystem: SourceSystemCode): Promise<boolean> {
  const credential = await loadCredential(sourceSystem);
  return credential !== null && credential.status === 'CONNECTED';
}

/** What the admin screen shows. Never returns any part of the secret. */
export async function credentialSummary(
  sourceSystem: SourceSystemCode,
  db?: Database,
): Promise<CredentialSummary> {
  const empty: CredentialSummary = {
    sourceSystem,
    connected: false,
    origin: null,
    authMethod: null,
    accountLabel: null,
    accountId: null,
    scopes: null,
    expiresAt: null,
    lastRefreshedAt: null,
    lastError: null,
    connectedAt: null,
  };

  try {
    const database = db ?? (await getDb());
    const [row] = await database
      .select()
      .from(t.connectorCredential)
      .where(eq(t.connectorCredential.sourceSystem, sourceSystem))
      .limit(1);

    if (row) {
      return {
        sourceSystem,
        connected: row.status === 'CONNECTED',
        origin: 'database',
        authMethod: row.authMethod as AuthMethod,
        accountLabel: row.accountLabel,
        accountId: row.accountId,
        scopes: row.scopes,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
        lastError: row.lastError,
        connectedAt: row.connectedAt?.toISOString() ?? null,
      };
    }
  } catch {
    // Table not present yet.
  }

  const environment = fromEnvironment(sourceSystem);
  if (!environment) return empty;

  return {
    ...empty,
    connected: true,
    origin: 'environment',
    authMethod: environment.authMethod,
    accountLabel: environment.accountLabel,
    accountId: environment.accountId,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveCredentialInput {
  sourceSystem: SourceSystemCode;
  authMethod: AuthMethod;
  data: Record<string, string>;
  accountLabel?: string | null;
  accountId?: string | null;
  scopes?: string | null;
  expiresAt?: Date | null;
  connectedByUserId?: string | null;
}

export async function saveCredential(input: SaveCredentialInput, db?: Database): Promise<void> {
  const database = db ?? (await getDb());
  const secret = encryptSecret(JSON.stringify(input.data));

  const row = {
    sourceSystem: input.sourceSystem,
    status: 'CONNECTED',
    authMethod: input.authMethod,
    secret,
    accountLabel: input.accountLabel ?? null,
    accountId: input.accountId ?? null,
    scopes: input.scopes ?? null,
    expiresAt: input.expiresAt ?? null,
    lastRefreshedAt: new Date(),
    lastError: null,
    connectedByUserId: input.connectedByUserId ?? null,
    updatedAt: new Date(),
  };

  await database
    .insert(t.connectorCredential)
    .values(row)
    .onConflictDoUpdate({ target: t.connectorCredential.sourceSystem, set: row });
}

/** Records a failure without discarding the credential — the token may still be good. */
export async function markCredentialError(
  sourceSystem: SourceSystemCode,
  message: string,
  db?: Database,
): Promise<void> {
  try {
    const database = db ?? (await getDb());
    await database
      .update(t.connectorCredential)
      .set({ status: 'ERROR', lastError: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(t.connectorCredential.sourceSystem, sourceSystem));
  } catch {
    // Recording the error must never be what breaks the refresh.
  }
}

export async function deleteCredential(
  sourceSystem: SourceSystemCode,
  db?: Database,
): Promise<void> {
  const database = db ?? (await getDb());
  await database
    .delete(t.connectorCredential)
    .where(eq(t.connectorCredential.sourceSystem, sourceSystem));
}
