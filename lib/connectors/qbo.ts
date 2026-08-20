/**
 * QuickBooks Online connector — §5.1.
 *
 * Read-only. There is no write method on this object, which is how Rule 7
 * ("Never modify source systems") is enforced: not by a flag someone can flip,
 * but by the absence of any code that could.
 *
 * Class is the mechanism for division separation. Class -> division mapping goes
 * through DIM_DIVISION.qbo_class_ids, never through a literal in this file.
 */
import {
  ConnectorNotConfiguredError,
  lastDayOfMonth,
  monthsInWindow,
  requestWithRetry,
  type EntityDescriptor,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
} from './types';
import { isConnected, loadCredential, saveCredential } from './credentials';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function baseUrl(): string {
  return process.env.QBO_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

const ENTITIES: EntityDescriptor[] = [
  {
    entity: 'profit_and_loss',
    label: 'Profit & Loss by Class, by month',
    cadence: 'DAILY',
    description:
      'The five reporting lines per division per month. Open months refresh nightly; closed months are frozen.',
  },
  {
    entity: 'balance_sheet',
    label: 'Balance Sheet by Class, by month',
    cadence: 'DAILY',
    description:
      'Month-end balances. Drives DSO, DPO, CCC and Cash Runway. Availability by division depends on whether ARG classes its balance sheet (open item 1).',
  },
  {
    entity: 'trial_balance',
    label: 'Trial Balance (account level)',
    cadence: 'ON_CLOSE',
    description:
      'Account-level detail. Enables drill-down, the self-generating audit pack, and variance commentary that can say why a line moved.',
  },
  {
    entity: 'ar_aging',
    label: 'A/R Aging Summary',
    cadence: 'DAILY',
    description: 'Feeds the aging view and the DSO reconciliation.',
  },
  {
    entity: 'ap_aging',
    label: 'A/P Aging Summary',
    cadence: 'DAILY',
    description: 'Feeds the DPO reconciliation.',
  },
  {
    entity: 'accounts',
    label: 'Chart of Accounts',
    cadence: 'WEEKLY',
    description: 'Reference data. Alerts on new accounts so nothing lands unmapped.',
  },
  {
    entity: 'classes',
    label: 'Class list',
    cadence: 'WEEKLY',
    description: 'Reference data. Alerts on new classes so nothing lands unmapped.',
  },
];

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}
let tokenCache: TokenCache | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const credential = await loadCredential('QBO');
  if (!credential) throw new ConnectorNotConfiguredError('QBO');

  const { clientId, clientSecret, refreshToken } = credential.data;
  if (!clientId || !clientSecret || !refreshToken) throw new ConnectorNotConfiguredError('QBO');

  const response = await requestWithRetry(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    },
    'QBO',
  );

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  // Intuit ROTATES the refresh token on every use and expires the old one. If
  // the new value is not written back, the connection works today and dies
  // silently the next time the cached access token lapses. This one line is the
  // difference between a connector that lasts and one that fails in a month.
  if (json.refresh_token && json.refresh_token !== refreshToken && credential.origin === 'database') {
    await saveCredential({
      sourceSystem: 'QBO',
      authMethod: 'OAUTH',
      data: { ...credential.data, refreshToken: json.refresh_token },
      accountLabel: credential.accountLabel,
      accountId: credential.accountId,
      scopes: credential.scopes,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    });
  }

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function callApi(path: string, params: Record<string, string>): Promise<unknown> {
  const credential = await loadCredential('QBO');
  const realmId = credential?.data.realmId;
  if (!realmId) throw new ConnectorNotConfiguredError('QBO');

  const url = new URL(`${baseUrl()}/v3/company/${realmId}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await requestWithRetry(
    url.toString(),
    {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: 'application/json',
      },
    },
    'QBO',
  );
  return response.json();
}

/**
 * QBO's report API summarises by month OR by class, not both in one call, so
 * classed monthly figures come from one call per month. That is more requests
 * but it is the only shape that yields a division dimension.
 */
async function fetchMonthlyReport(
  reportName: string,
  window: FetchWindow,
  extraParams: Record<string, string> = {},
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];

  for (const month of monthsInWindow(window)) {
    const payload = await callApi(`reports/${reportName}`, {
      start_date: month,
      end_date: lastDayOfMonth(month),
      // Rule 3: ARG reports on the accrual basis. Never mix silently.
      accounting_method: 'Accrual',
      ...extraParams,
    });
    records.push({ entity: reportName, key: month, payload });
  }

  return records;
}

/**
 * The reports that accept `summarize_column_by=Classes`.
 *
 * Sending it to a report that does not support it is not a no-op: QBO answers
 * with the unsummarised report, which parses cleanly and has no division
 * dimension at all. The load would then look successful and produce nothing.
 */
const CLASSED = { summarize_column_by: 'Classes' } as const;

export const qboConnector: SourceConnector = {
  sourceSystem: 'QBO',
  label: 'QuickBooks Online',

  entities: () => ENTITIES,

  isConfigured: () => isConnected('QBO'),

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    if (!(await qboConnector.isConfigured())) throw new ConnectorNotConfiguredError('QBO');

    let records: RawRecord[];

    switch (entity) {
      case 'profit_and_loss':
        records = await fetchMonthlyReport('ProfitAndLoss', window, { ...CLASSED });
        break;
      case 'balance_sheet':
        records = await fetchMonthlyReport('BalanceSheet', window, { ...CLASSED });
        break;
      case 'trial_balance':
        records = await fetchMonthlyReport('TrialBalance', window, { ...CLASSED });
        break;
      // The aging reports summarise by aging bucket, so the class summary is
      // not available on them. They are fetched at portal level and their use
      // is the DSO and DPO reconciliation, which is an ARG-Total check.
      case 'ar_aging':
        records = await fetchMonthlyReport('AgedReceivables', window);
        break;
      case 'ap_aging':
        records = await fetchMonthlyReport('AgedPayables', window);
        break;
      case 'accounts':
        records = [
          {
            entity: 'accounts',
            key: 'all',
            payload: await callApi('query', { query: 'select * from Account maxresults 1000' }),
          },
        ];
        break;
      case 'classes':
        records = [
          {
            entity: 'classes',
            key: 'all',
            payload: await callApi('query', { query: 'select * from Class maxresults 1000' }),
          },
        ];
        break;
      default:
        throw new Error(`Unknown QBO entity "${entity}".`);
    }

    return { sourceSystem: 'QBO', entity, window, records, fetchedAt: new Date() };
  },
};
