/**
 * Google Sheets connector — read-only.
 *
 * Not in the original spec, added at ARG's direction: budget, headcount and any
 * hand-maintained data live in Sheets today. Reading them here is what removes
 * the last place a human has to retype a number.
 *
 * Sheets are sources, never destinations. Nothing here writes back.
 */
import { SignJWT, importPKCS8 } from 'jose';
import {
  ConnectorNotConfiguredError,
  requestWithRetry,
  type EntityDescriptor,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
} from './types';
import { isConnected, loadCredential } from './credentials';
import { proxy } from './composio';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const ENTITIES: EntityDescriptor[] = [
  {
    entity: 'monthly_budget',
    label: 'Monthly Budget (FY2026)',
    cadence: 'MONTHLY',
    description:
      'Revenue, COGS and OpEx by division and month. GP and NP are recomputed on load, never imported, so the identity always holds.',
  },
  {
    entity: 'tenx_budget',
    label: '10X Budget (2026–2029)',
    cadence: 'MONTHLY',
    description: 'Annual targets divided straight-line by 12.',
  },
  {
    entity: 'headcount',
    label: 'Monthly headcount',
    cadence: 'MONTHLY',
    description:
      'iSolved API access is limited, so a monthly figure from Sheets is the expected path. Feeds Revenue per Employee.',
  },
];

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}
let tokenCache: TokenCache | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;

  const credential = await loadCredential('SHEETS');
  const email = credential?.data.clientEmail;
  const rawKey = credential?.data.privateKey;
  if (!email || !rawKey) throw new ConnectorNotConfiguredError('SHEETS');

  // Env vars carry the PEM with literal \n sequences.
  const privateKey = await importPKCS8(rawKey.replace(/\\n/g, '\n'), 'RS256');

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await requestWithRetry(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    },
    'SHEETS',
  );

  const json = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/** Named ranges, configurable so a sheet rename is not a deploy. */
const RANGES: Record<string, string> = {
  monthly_budget: process.env.SHEETS_RANGE_MONTHLY_BUDGET ?? 'Monthly Budget!A1:Z200',
  tenx_budget: process.env.SHEETS_RANGE_TENX_BUDGET ?? '10X Budget!A1:Z200',
  headcount: process.env.SHEETS_RANGE_HEADCOUNT ?? 'Headcount!A1:Z200',
};

/**
 * One range, however the connection was authorised.
 *
 * Signing in with Google replaces the service-account key file entirely: the
 * person who owns the spreadsheet authorises it as themselves, and there is no
 * separate step where a robot's email address has to be added as a viewer —
 * which is the step everybody forgets and which fails silently at 3am.
 */
export async function readRange(spreadsheetId: string, range: string): Promise<string[][]> {
  const credential = await loadCredential('SHEETS');
  if (!credential) throw new ConnectorNotConfiguredError('SHEETS');

  const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  if (credential.authMethod === 'COMPOSIO') {
    const connectedAccountId = credential.data.connectedAccountId;
    if (!connectedAccountId) throw new ConnectorNotConfiguredError('SHEETS');

    const json = await proxy<{ values?: string[][] }>({
      connectedAccountId,
      endpoint: path,
      method: 'GET',
      query: { valueRenderOption: 'UNFORMATTED_VALUE' },
      headers: { accept: 'application/json' },
    });
    return json.values ?? [];
  }

  const url = new URL(`https://sheets.googleapis.com${path}`);
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');

  const response = await requestWithRetry(
    url.toString(),
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
    'SHEETS',
  );
  const json = (await response.json()) as { values?: string[][] };
  return json.values ?? [];
}

export const sheetsConnector: SourceConnector = {
  sourceSystem: 'SHEETS',
  label: 'Google Sheets',

  entities: () => ENTITIES,

  /**
   * Signing in is not enough for Sheets: Google grants access to an account, not
   * to a document. Until a spreadsheet has been named the source reports as not
   * connected, because a connector that says "connected" and then has nothing to
   * read is the failure this codebase keeps refusing to ship.
   */
  async isConfigured(): Promise<boolean> {
    if (!(await isConnected('SHEETS'))) return false;
    const credential = await loadCredential('SHEETS');
    return Boolean(credential?.data.spreadsheetId);
  },

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    if (!(await sheetsConnector.isConfigured())) throw new ConnectorNotConfiguredError('SHEETS');

    const range = RANGES[entity];
    if (!range) throw new Error(`Unknown Sheets entity "${entity}".`);

    const spreadsheetId = (await loadCredential('SHEETS'))?.data.spreadsheetId;
    if (!spreadsheetId) throw new ConnectorNotConfiguredError('SHEETS');
    const values = await readRange(spreadsheetId, range);
    const records: RawRecord[] = [{ entity, key: range, payload: { range, values } }];

    return { sourceSystem: 'SHEETS', entity, window, records, fetchedAt: new Date() };
  },
};
