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

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
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

export async function readRange(spreadsheetId: string, range: string): Promise<string[][]> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
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

  isConfigured: () =>
    Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        process.env.GOOGLE_PRIVATE_KEY &&
        process.env.GOOGLE_BUDGET_SPREADSHEET_ID,
    ),

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    if (!sheetsConnector.isConfigured()) throw new ConnectorNotConfiguredError('SHEETS');

    const range = RANGES[entity];
    if (!range) throw new Error(`Unknown Sheets entity "${entity}".`);

    const values = await readRange(process.env.GOOGLE_BUDGET_SPREADSHEET_ID!, range);
    const records: RawRecord[] = [{ entity, key: range, payload: { range, values } }];

    return { sourceSystem: 'SHEETS', entity, window, records, fetchedAt: new Date() };
  },
};
