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
import { executeTool, proxy } from './composio';

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

/**
 * An explicit range per entity, when somebody has set one.
 *
 * Left unset — which is the normal case — the tab is FOUND rather than assumed.
 * Assuming was the whole bug: all three entities returned nothing because the
 * spreadsheet's tabs are not called "Monthly Budget", "10X Budget" and
 * "Headcount", and a range naming a tab that does not exist comes back as an
 * empty result rather than as an error. Three empty imports, no reason given,
 * for months.
 */
const EXPLICIT_RANGES: Record<string, string | undefined> = {
  monthly_budget: process.env.SHEETS_RANGE_MONTHLY_BUDGET,
  tenx_budget: process.env.SHEETS_RANGE_TENX_BUDGET,
  headcount: process.env.SHEETS_RANGE_HEADCOUNT,
};

/**
 * What a tab has to look like to be the one, in order of confidence.
 *
 * Matched against the real tab names read from the spreadsheet, so a tab called
 * "FY26 Budget", "Monthly budget " or "BUDGET" all land on the right entity
 * without anybody editing an environment variable. The order matters: "10X"
 * is checked before the generic budget terms, because a sheet containing both
 * must not have its 10X plan loaded as the operating budget.
 */
const TAB_PATTERNS: Record<string, RegExp[]> = {
  tenx_budget: [/\b10\s*x\b/i, /\bten\s*x\b/i, /growth\s*plan/i],
  monthly_budget: [/monthly\s*budget/i, /\bbudget\b/i, /\bplan\b/i],
  headcount: [/head\s*count/i, /\bfte\b/i, /employees?/i, /staff/i],
};

export interface SheetTab {
  title: string;
}

/** The spreadsheet's real tab names. */
export async function listTabs(spreadsheetId: string): Promise<string[]> {
  const credential = await loadCredential('SHEETS');
  if (!credential) throw new ConnectorNotConfiguredError('SHEETS');

  const path = `/v4/spreadsheets/${spreadsheetId}`;
  const query = { fields: 'sheets.properties.title' };

  if (credential.authMethod === 'COMPOSIO') {
    const connectedAccountId = credential.data.connectedAccountId;
    if (!connectedAccountId) throw new ConnectorNotConfiguredError('SHEETS');

    /**
     * Two routes, because the raw proxy has already failed this twice.
     *
     * Composio ships a packaged Google Sheets tool whose response shape it
     * maintains; the proxy hands back whatever envelope Composio happens to wrap
     * the provider in this month, and a field added to that envelope is what
     * made the tabs read as "(none)" for a spreadsheet with four of them.
     *
     * The packaged tool is tried first for that reason. The proxy remains as a
     * fallback, and when BOTH fail the error carries both reasons — because
     * "it did not work" without saying which route was tried is how this took
     * three rounds to pin down.
     */
    const attempts: string[] = [];

    for (const slug of ['GOOGLESHEETS_GET_SPREADSHEET_INFO', 'GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER']) {
      try {
        const result = await executeTool<Record<string, unknown>>(slug, {
          connectedAccountId,
          arguments: { spreadsheet_id: spreadsheetId, spreadsheetId },
        });
        return tabTitles(result, `Composio's ${slug}`);
      } catch (error) {
        attempts.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const json = await proxy<{ sheets?: Array<{ properties?: { title?: string } }> }>({
        connectedAccountId,
        endpoint: path,
        method: 'GET',
        query,
        headers: { accept: 'application/json' },
      });
      return tabTitles(json, 'the Composio proxy');
    } catch (error) {
      attempts.push(`proxy ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(
      `Could not read the spreadsheet's tabs through any available route. Tried — ` +
        `${attempts.join(' | ')}. The connection itself is fine; this is how the data is being ` +
        `requested. Setting SHEETS_RANGE_MONTHLY_BUDGET, SHEETS_RANGE_TENX_BUDGET and ` +
        `SHEETS_RANGE_HEADCOUNT to explicit A1 ranges skips tab discovery entirely and will ` +
        `import while this is sorted out.`,
    );
  }

  const url = new URL(`https://sheets.googleapis.com${path}`);
  url.searchParams.set('fields', query.fields);

  const response = await requestWithRetry(
    url.toString(),
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
    'SHEETS',
  );
  return tabTitles(await response.json(), 'the Sheets API');
}

/**
 * Tab titles, or a loud failure naming what actually came back.
 *
 * `?? []` here is what produced "the tabs it has are: (none)" for a spreadsheet
 * that was connected and had four tabs. A response missing `sheets` entirely is
 * not a spreadsheet with no tabs — a spreadsheet always has at least one — so
 * reading it as an empty list states something that cannot be true, and points
 * the reader at their tab names instead of at the response.
 */
function tabTitles(payload: unknown, via: string): string[] {
  // A packaged tool nests the spreadsheet under its own key; the proxy returns
  // it bare. Both are accepted rather than one being assumed.
  const outer = payload as Record<string, unknown> | null;
  const nested =
    outer && typeof outer === 'object'
      ? ((outer.spreadsheet ?? outer.response ?? outer.result) as Record<string, unknown> | undefined)
      : undefined;

  const json = (nested && Array.isArray(nested.sheets) ? nested : outer) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  } | null;

  if (!json || typeof json !== 'object' || !Array.isArray(json.sheets)) {
    const keys = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(
      `The spreadsheet metadata came back from ${via} without a "sheets" array, so its tabs ` +
        `could not be read. The response carried: ${keys || '(nothing)'}. This is a transport ` +
        `problem, not a naming one — the tabs are fine.`,
    );
  }

  const titles = json.sheets.map((sheet) => sheet.properties?.title ?? '').filter(Boolean);
  if (!titles.length) {
    throw new Error(
      `${via} returned ${json.sheets.length} sheet entr${json.sheets.length === 1 ? 'y' : 'ies'} ` +
        `but none carried a title, so no tab could be named.`,
    );
  }
  return titles;
}

/**
 * The tab an entity should read, chosen from the tabs that actually exist.
 *
 * Returns null rather than falling back to a guess, so the caller can say which
 * tabs it did find. "No tab matched, and here are the seven that exist" is a
 * problem somebody can fix in a minute; "that range came back empty" is not.
 */
export function matchTab(entity: string, tabs: string[]): string | null {
  const patterns = TAB_PATTERNS[entity] ?? [];

  // Claimed by a more specific entity: a tab matching 10X must never also be
  // taken as the monthly budget.
  const claimedByOther = (tab: string) =>
    Object.entries(TAB_PATTERNS).some(
      ([other, otherPatterns]) =>
        other !== entity &&
        TAB_PRIORITY.indexOf(other) < TAB_PRIORITY.indexOf(entity) &&
        otherPatterns.some((pattern) => pattern.test(tab)),
    );

  for (const pattern of patterns) {
    const hit = tabs.find((tab) => pattern.test(tab) && !claimedByOther(tab));
    if (hit) return hit;
  }
  return null;
}

/** Most specific first. A tab is offered to each entity in this order. */
const TAB_PRIORITY = ['tenx_budget', 'headcount', 'monthly_budget'];

/** A whole tab. Columns are bounded generously; empty ones cost nothing. */
function rangeForTab(tab: string): string {
  // Single quotes are the A1 escape for a tab name containing spaces, and a
  // literal quote inside the name is escaped by doubling it.
  return `'${tab.replace(/'/g, "''")}'!A1:ZZ2000`;
}

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
    return rangeValues(json, range, 'the Composio proxy');
  }

  const url = new URL(`https://sheets.googleapis.com${path}`);
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');

  const response = await requestWithRetry(
    url.toString(),
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
    'SHEETS',
  );
  return rangeValues(await response.json(), range, 'the Sheets API');
}

/**
 * A range's rows, distinguishing "this range is empty" from "this is not a
 * Sheets response".
 *
 * Google omits `values` for a genuinely empty range, so an absent key with an
 * otherwise well-formed response is a real empty — returned as such. A response
 * that is not shaped like a Sheets reply at all is a transport failure, and
 * saying so is what stops it being read as an empty budget.
 */
function rangeValues(payload: unknown, range: string, via: string): string[][] {
  const json = payload as { values?: unknown; range?: unknown; majorDimension?: unknown } | null;

  if (!json || typeof json !== 'object') {
    throw new Error(`${range} came back from ${via} as ${typeof json}, not as a Sheets response.`);
  }

  if (Array.isArray(json.values)) return json.values as string[][];

  // A real Sheets reply for an empty range still identifies the range it read.
  if (typeof json.range === 'string' || typeof json.majorDimension === 'string') return [];

  throw new Error(
    `${range} came back from ${via} without a "values" array and without naming the range it ` +
      `read, so it cannot be told apart from a failed request. The response carried: ` +
      `${Object.keys(json).join(', ') || '(nothing)'}.`,
  );
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
    if (!ENTITIES.some((descriptor) => descriptor.entity === entity)) {
      throw new Error(`Unknown Sheets entity "${entity}".`);
    }

    const spreadsheetId = (await loadCredential('SHEETS'))?.data.spreadsheetId;
    if (!spreadsheetId) throw new ConnectorNotConfiguredError('SHEETS');

    let range = EXPLICIT_RANGES[entity];
    let tabs: string[] = [];

    if (!range) {
      tabs = await listTabs(spreadsheetId);
      const tab = matchTab(entity, tabs);

      if (!tab) {
        // Naming the tabs that DO exist is the whole point. Anybody can fix a
        // wrong tab name in seconds once they can see the list.
        throw new Error(
          `No tab in the connected spreadsheet looks like "${entity.replace(/_/g, ' ')}". ` +
            `The tabs it has are: ${tabs.join(', ')}. ` +
            `Rename the right one, or set ${
              entity === 'monthly_budget'
                ? 'SHEETS_RANGE_MONTHLY_BUDGET'
                : entity === 'tenx_budget'
                  ? 'SHEETS_RANGE_TENX_BUDGET'
                  : 'SHEETS_RANGE_HEADCOUNT'
            } to an explicit A1 range.`,
        );
      }
      range = rangeForTab(tab);
    }

    const values = await readRange(spreadsheetId, range);

    if (values.length === 0) {
      throw new Error(
        `The range ${range} exists but holds no rows. ` +
          (tabs.length ? `Tabs in this spreadsheet: ${tabs.join(', ')}. ` : '') +
          `Nothing was written — an empty budget and a budget that failed to load must not look ` +
          `the same on a variance chart.`,
      );
    }

    const records: RawRecord[] = [{ entity, key: range, payload: { range, values } }];

    // One range, one request. There is nothing here to slice, so a Sheets
    // entity always completes in the slice that starts it.
    return { sourceSystem: 'SHEETS', entity, window, records, fetchedAt: new Date(), nextCursor: null };
  },
};
