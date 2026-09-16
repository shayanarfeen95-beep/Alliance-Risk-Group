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
  ConnectorRequestError,
  budgetSpent,
  lastDayOfMonth,
  monthsInWindow,
  requestWithRetry,
  type EntityDescriptor,
  type FetchOptions,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
} from './types';
import { isConnected, loadCredential, saveCredential } from './credentials';
import { proxy } from './composio';

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

/**
 * Which QBO report backs each monthly entity, and the parameters it accepts.
 *
 * QuickBooks does NOT take the same query parameters on every report, and it
 * answers an unsupported one with a 400 rather than ignoring it. Every monthly
 * report was being sent `summarize_column_by=Classes` and a `start_date`, which
 * only the P&L and Balance Sheet accept — that is why the balance sheet run
 * FAILED outright and the trial balance and both aging pulls came back with
 * nothing to conform. Each report's real parameter shape is declared here
 * instead of being assumed uniform.
 */
interface ReportSpec {
  report: string;
  /** A range (P&L, TB) or a position at a date (aging). */
  period: 'range' | 'as_of';
  acceptsBasis: boolean;
  /**
   * Whether a per-class breakdown may be requested. Requesting one is not the
   * same as getting one: a company that does not class this report answers with
   * a single total column, which conform reports rather than mistaking for zero.
   */
  acceptsClasses: boolean;
  /** Explicit column list, for the detail reports that take one. */
  columns?: string;
}

const MONTHLY_REPORTS: Record<string, ReportSpec> = {
  profit_and_loss: { report: 'ProfitAndLoss', period: 'range', acceptsBasis: true, acceptsClasses: true },
  balance_sheet: { report: 'BalanceSheet', period: 'range', acceptsBasis: true, acceptsClasses: true },
  // QuickBooks' Trial Balance has no class dimension at all. It is pulled at
  // company level as the tie-out against the classed P&L and balance sheet;
  // asking it to summarise by class is what made it fail.
  trial_balance: { report: 'TrialBalance', period: 'range', acceptsBasis: true, acceptsClasses: false },
  // The DETAIL aging reports, not the summary ones. The summary is by customer
  // or vendor and carries no class, so it could never be split by division —
  // which is why fact_aging stayed empty and conform declined to touch it. The
  // detail report returns one row per open transaction and can carry a class.
  ar_aging: {
    report: 'AgedReceivableDetail',
    period: 'as_of',
    acceptsBasis: false,
    acceptsClasses: false,
    columns: 'klass_name,due_date,past_due,open_balance,txn_type,doc_num,cust_name',
  },
  ap_aging: {
    report: 'AgedPayableDetail',
    period: 'as_of',
    acceptsBasis: false,
    acceptsClasses: false,
    columns: 'klass_name,due_date,past_due,open_balance,txn_type,doc_num,vend_name',
  },
};

/** The query parameters one month of a report actually takes. */
export function reportParams(
  spec: ReportSpec,
  month: string,
  withClasses: boolean,
): Record<string, string> {
  const monthEnd = lastDayOfMonth(month);
  const params: Record<string, string> = {};

  if (spec.period === 'range') {
    params.start_date = month;
    params.end_date = monthEnd;
  } else {
    // Aging is as-at a single date, under a different parameter name entirely.
    params.report_date = monthEnd;
  }

  if (spec.columns) params.columns = spec.columns;
  // Rule 3: ARG reports on the accrual basis. Never mix silently.
  if (spec.acceptsBasis) params.accounting_method = 'Accrual';
  if (spec.acceptsClasses && withClasses) params.summarize_column_by = 'Classes';

  return params;
}

export const REPORT_SPECS = MONTHLY_REPORTS;

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

/**
 * One call to QuickBooks, however the connection was authorised.
 *
 * Both paths hit the same Intuit endpoints with the same parameters, so the
 * report shapes downstream are identical and there is no second, weaker
 * ingestion route to keep in step. What differs is only who holds the token:
 * Composio injects it server-side, and this process never sees it.
 */
async function callApi(path: string, params: Record<string, string>): Promise<unknown> {
  const credential = await loadCredential('QBO');
  const realmId = credential?.data.realmId;
  if (!credential || !realmId) throw new ConnectorNotConfiguredError('QBO');

  if (credential.authMethod === 'COMPOSIO') {
    const connectedAccountId = credential.data.connectedAccountId;
    if (!connectedAccountId) throw new ConnectorNotConfiguredError('QBO');

    return proxy<unknown>({
      connectedAccountId,
      endpoint: `/v3/company/${realmId}/${path}`,
      method: 'GET',
      query: params,
      headers: { accept: 'application/json' },
    });
  }

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
 *
 * A classed request that fails is retried once, unclassed. That is open item 1
 * behaving as documented rather than as an outage: a company that does not class
 * its balance sheet gets ARG Total figures and a conform note, where before the
 * entity simply FAILED and the balance sheet never loaded at all.
 */
async function fetchMonthlyReport(
  spec: ReportSpec,
  window: FetchWindow,
  extraParams: Record<string, string> = {},
  options?: FetchOptions,
): Promise<{ records: RawRecord[]; nextCursor: string | null }> {
  const records: RawRecord[] = [];

  // The month boundary is the only place a report fetch may be interrupted.
  // Conform replaces a month wholesale, so half a month landing on its own would
  // read as a genuine collapse in that month's figures rather than as an
  // unfinished pull. A month is fetched entirely or not at all.
  const months = monthsInWindow(window);
  const resumeAt = options?.cursor ? months.indexOf(options.cursor) : 0;
  const from = resumeAt < 0 ? 0 : resumeAt;

  for (let i = from; i < months.length; i++) {
    const month = months[i]!;

    let payload: unknown;
    try {
      payload = await callApi(`reports/${spec.report}`, {
        ...reportParams(spec, month, true),
        ...extraParams,
      });
    } catch (error) {
      if (!spec.acceptsClasses || !(error instanceof ConnectorRequestError)) throw error;
      payload = await callApi(`reports/${spec.report}`, {
        ...reportParams(spec, month, false),
        ...extraParams,
      });
    }

    records.push({ entity: spec.report, key: month, payload });

    const next = months[i + 1];
    if (next && budgetSpent(options, records.length)) return { records, nextCursor: next };
  }

  return { records, nextCursor: null };
}

export const qboConnector: SourceConnector = {
  sourceSystem: 'QBO',
  label: 'QuickBooks Online',

  entities: () => ENTITIES,

  isConfigured: () => isConnected('QBO'),

  async fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch> {
    if (!(await qboConnector.isConfigured())) throw new ConnectorNotConfiguredError('QBO');

    let records: RawRecord[];
    let nextCursor: string | null = null;

    switch (entity) {
      case 'profit_and_loss':
      case 'balance_sheet':
      case 'trial_balance':
      case 'ar_aging':
      case 'ap_aging': {
        const spec = MONTHLY_REPORTS[entity]!;
        ({ records, nextCursor } = await fetchMonthlyReport(spec, window, {}, options));
        break;
      }
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

    return { sourceSystem: 'QBO', entity, window, records, fetchedAt: new Date(), nextCursor };
  },
};
