import 'server-only';
import {
  ConnectorNotConfiguredError,
  ConnectorRequestError,
  lastDayOfMonth,
  monthsInWindow,
  type EntityDescriptor,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
  type SourceSystemCode,
} from './types';
import { isConnected, loadCredential, saveCredential } from './credentials';

/**
 * Connecting through Composio instead of directly.
 *
 * Composio hosts the OAuth dance for QuickBooks and HubSpot, which removes the
 * one piece of real friction in the direct path: registering an app at
 * developer.intuit.com and holding its client secret. With this, connecting
 * QuickBooks is a click.
 *
 * It is offered *alongside* the direct connectors, not instead of them, and the
 * trade is worth stating plainly because it is ARG's to make rather than ours:
 *
 *   1. **The connection Composio holds is write-capable.** Its HubSpot toolkit
 *      includes `HUBSPOT_UPDATE_DEALS`; its QuickBooks toolkit can write too.
 *      This code never names a write slug — the same read-only-by-absence
 *      property the direct connectors have — but the token at Composio's end
 *      could. Direct HubSpot connection with a private-app token scoped to the
 *      four read scopes is genuinely stronger, and stays the recommendation.
 *   2. **ARG's financial data passes through a third party.** That is a
 *      decision for ARG and Westport, not a default anyone should be opted
 *      into.
 *
 * What it does not change: the conform layer, the reconciliation controls, the
 * closed-month rule, and every KPI definition. This produces the same
 * `RawBatch` the direct connectors produce, so everything downstream cannot
 * tell which path the data arrived by — and no guarantee depends on it.
 */

const BASE = process.env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev';

export function isComposioAvailable(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

/** The auth config Composio issues per toolkit, created once in its dashboard. */
export function authConfigFor(sourceSystem: SourceSystemCode): string | undefined {
  if (sourceSystem === 'QBO') return process.env.COMPOSIO_AUTH_CONFIG_QUICKBOOKS;
  if (sourceSystem === 'HUBSPOT') return process.env.COMPOSIO_AUTH_CONFIG_HUBSPOT;
  return undefined;
}

export const COMPOSIO_TOOLKITS: Partial<Record<SourceSystemCode, string>> = {
  QBO: 'quickbooks',
  HUBSPOT: 'hubspot',
};

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error('COMPOSIO_API_KEY is not set.');

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ConnectorRequestError('COMPOSIO' as SourceSystemCode, response.status, text);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Composio returned a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export interface ComposioConnection {
  id: string;
  status: string;
  redirectUrl: string | null;
}

/**
 * Starts a connection and returns the URL to send the user to.
 *
 * `user_id` scopes the connection at Composio's end. It is the ARG deployment
 * rather than the individual — the connection belongs to the company's books,
 * not to whoever happened to click Connect, and it must keep working when that
 * person leaves.
 */
export async function initiateComposioConnection(
  sourceSystem: SourceSystemCode,
  callbackUrl: string,
): Promise<ComposioConnection> {
  const authConfigId = authConfigFor(sourceSystem);
  if (!authConfigId) {
    throw new Error(
      `No Composio auth config is set for ${sourceSystem}. Create one in the Composio dashboard ` +
        `for the ${COMPOSIO_TOOLKITS[sourceSystem]} toolkit and set ` +
        `${sourceSystem === 'QBO' ? 'COMPOSIO_AUTH_CONFIG_QUICKBOOKS' : 'COMPOSIO_AUTH_CONFIG_HUBSPOT'}.`,
    );
  }

  const body = await call<{ id: string; status: string; redirect_url: string | null }>(
    '/api/v3.1/connected_accounts',
    {
      method: 'POST',
      body: JSON.stringify({
        auth_config: { id: authConfigId },
        connection: {
          user_id: process.env.COMPOSIO_USER_ID ?? 'alliance-risk-group',
          callback_url: callbackUrl,
        },
      }),
    },
  );

  return { id: body.id, status: body.status, redirectUrl: body.redirect_url };
}

export async function getComposioConnection(id: string): Promise<ComposioConnection> {
  const body = await call<{ id: string; status: string; redirect_url?: string | null }>(
    `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`,
    { method: 'GET' },
  );
  return { id: body.id, status: body.status, redirectUrl: body.redirect_url ?? null };
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

interface ExecuteResponse {
  data: unknown;
  error: string | null;
  successful: boolean;
}

async function execute(
  sourceSystem: SourceSystemCode,
  toolSlug: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const credential = await loadCredential(sourceSystem);
  const connectedAccountId = credential?.data.composioConnectedAccountId;
  if (!connectedAccountId) throw new ConnectorNotConfiguredError(sourceSystem);

  const body = await call<ExecuteResponse>(
    `/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`,
    {
      method: 'POST',
      body: JSON.stringify({ arguments: args, connected_account_id: connectedAccountId }),
    },
  );

  // Composio reports upstream failures inside a 200. Treating `successful:
  // false` as data would conform an error object into the warehouse.
  if (!body.successful) {
    throw new Error(
      `Composio could not run ${toolSlug}: ${body.error ?? 'no reason given'}. Nothing was conformed.`,
    );
  }

  return body.data;
}

/**
 * Finds the provider's own payload inside Composio's envelope.
 *
 * Composio wraps a response in `data`, and depending on the tool the useful
 * object may be one level further down again. The conform layer parses
 * QuickBooks' native report tree, so what it needs is the object carrying
 * `Rows` and `Columns` — not whichever wrapper happens to be outermost.
 *
 * Unwrapping by looking for the markers rather than by assuming a depth means a
 * change to Composio's envelope does not silently produce an empty report, and
 * a genuinely unrecognised shape is reported with the keys that were actually
 * there instead of a parse error thirty frames away.
 */
export function unwrapQboReport(payload: unknown): unknown {
  const seen: string[] = [];
  let node: unknown = payload;

  for (let depth = 0; depth < 5; depth += 1) {
    if (!node || typeof node !== 'object') break;
    const record = node as Record<string, unknown>;

    if ('Rows' in record && 'Columns' in record) return record;
    if ('Header' in record && 'Columns' in record) return record;

    seen.push(...Object.keys(record));

    const next =
      record.data ?? record.response_data ?? record.report ?? record.Report ?? record.result;
    if (next === undefined) break;
    node = next;
  }

  throw new Error(
    'Composio returned a QuickBooks report this parser does not recognise — no Rows/Columns block ' +
      `was found. Keys seen: ${[...new Set(seen)].slice(0, 12).join(', ') || 'none'}. The raw ` +
      'payload is retained under its load run, so this can be replayed once the shape is handled.',
  );
}

/** HubSpot list responses, unwrapped to the array of objects. */
export function unwrapHubspotList(payload: unknown): { results: unknown[]; after?: string } {
  const node = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const inner = (node.data ?? node) as Record<string, unknown>;

  const results = Array.isArray(inner.results)
    ? inner.results
    : Array.isArray(node.results)
      ? node.results
      : [];

  const paging = (inner.paging ?? node.paging) as { next?: { after?: string } } | undefined;
  return { results, after: paging?.next?.after };
}

// ---------------------------------------------------------------------------
// The connectors
// ---------------------------------------------------------------------------

const QBO_ENTITIES: EntityDescriptor[] = [
  {
    entity: 'profit_and_loss',
    label: 'Profit & Loss by Class, by month',
    cadence: 'DAILY',
    description: 'The five reporting lines per division per month, via Composio.',
  },
  {
    entity: 'balance_sheet',
    label: 'Balance Sheet by Class, by month',
    cadence: 'DAILY',
    description: 'Month-end balances. Drives DSO, DPO, CCC and Cash Runway.',
  },
];

const HUBSPOT_ENTITIES: EntityDescriptor[] = [
  {
    entity: 'deals',
    label: 'Deals (with stage history)',
    cadence: 'DAILY',
    description: 'Bookings and pipeline. Stage history is requested, as the funnel needs it.',
  },
  {
    entity: 'contacts',
    label: 'Contacts',
    cadence: 'DAILY',
    description: 'Leads by the date they became a lead.',
  },
  {
    entity: 'owners',
    label: 'Owners (salespeople)',
    cadence: 'WEEKLY',
    description: 'Turns the owner id on a deal into a name.',
  },
];

/**
 * Read slugs only.
 *
 * `HUBSPOT_UPDATE_DEALS` exists in the same toolkit and is deliberately absent
 * here. Rule 7 is held the same way it is everywhere else in this codebase —
 * by there being no code that could call it, rather than by a flag.
 */
const SLUGS = {
  profit_and_loss: 'QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT',
  balance_sheet: 'QUICKBOOKS_GET_BALANCE_SHEET_REPORT',
  deals: 'HUBSPOT_LIST_DEALS',
  contacts: 'HUBSPOT_LIST_CONTACTS',
  owners: 'HUBSPOT_RETRIEVE_OWNERS',
} as const;

const DEAL_PROPERTIES = [
  'dealname',
  'amount',
  'dealstage',
  'pipeline',
  'hs_is_closed_won',
  'hs_is_closed',
  'createdate',
  'closedate',
  'hubspot_owner_id',
];

const CONTACT_PROPERTIES = [
  'lifecyclestage',
  'createdate',
  'hs_analytics_source',
  'hs_lifecyclestage_lead_date',
  'hs_lifecyclestage_customer_date',
];

export const composioQboConnector: SourceConnector = {
  sourceSystem: 'QBO',
  label: 'QuickBooks Online (Composio)',
  entities: () => QBO_ENTITIES,
  isConfigured: () => isConnected('QBO'),

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    const slug = SLUGS[entity as 'profit_and_loss' | 'balance_sheet'];
    if (!slug) throw new Error(`Unknown QuickBooks entity "${entity}".`);

    const records: RawRecord[] = [];

    // One call per month, for the same reason the direct connector does it:
    // QuickBooks summarises by month OR by class, not both, and the division
    // dimension is the one we cannot do without.
    for (const month of monthsInWindow(window)) {
      const payload = await execute('QBO', slug, {
        start_date: month,
        end_date: lastDayOfMonth(month),
        accounting_method: 'Accrual',
        summarize_column_by: 'Classes',
      });

      records.push({ entity, key: month, payload: unwrapQboReport(payload) });
    }

    return { sourceSystem: 'QBO', entity, window, records, fetchedAt: new Date() };
  },
};

export const composioHubspotConnector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot (Composio)',
  entities: () => HUBSPOT_ENTITIES,
  isConfigured: () => isConnected('HUBSPOT'),

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    const records: RawRecord[] = [];

    if (entity === 'owners') {
      const payload = await execute('HUBSPOT', SLUGS.owners, {});
      for (const owner of unwrapHubspotList(payload).results) {
        const id = (owner as { id?: string }).id;
        if (id) records.push({ entity, key: id, payload: owner });
      }
      return { sourceSystem: 'HUBSPOT', entity, window, records, fetchedAt: new Date() };
    }

    const slug = entity === 'deals' ? SLUGS.deals : SLUGS.contacts;
    const divisionProperty = process.env.HUBSPOT_DIVISION_PROPERTY;

    const properties =
      entity === 'deals'
        ? divisionProperty
          ? [...DEAL_PROPERTIES, divisionProperty]
          : DEAL_PROPERTIES
        : divisionProperty
          ? [...CONTACT_PROPERTIES, divisionProperty]
          : CONTACT_PROPERTIES;

    let after: string | undefined;
    let pages = 0;

    do {
      const payload = await execute('HUBSPOT', slug, {
        // 50 rather than 100: HubSpot caps the page at 50 when stage history is
        // requested, and asking for more returns an error rather than fewer.
        limit: entity === 'deals' ? 50 : 100,
        properties,
        ...(entity === 'deals' ? { propertiesWithHistory: ['dealstage'] } : {}),
        ...(after ? { after } : {}),
      });

      const page = unwrapHubspotList(payload);
      for (const object of page.results) {
        const id = (object as { id?: string }).id;
        if (id) records.push({ entity, key: id, payload: object });
      }

      after = page.after;
      pages += 1;
      // A cursor that never advances would loop until the function times out.
      if (pages > 200) break;
    } while (after);

    return { sourceSystem: 'HUBSPOT', entity, window, records, fetchedAt: new Date() };
  },
};

/** Stores the connected account against the source, once Composio reports it active. */
export async function saveComposioConnection(
  sourceSystem: SourceSystemCode,
  connection: ComposioConnection,
  connectedByUserId: string | null,
): Promise<void> {
  await saveCredential({
    sourceSystem,
    authMethod: 'OAUTH',
    data: { composioConnectedAccountId: connection.id, via: 'composio' },
    accountLabel: `via Composio · ${COMPOSIO_TOOLKITS[sourceSystem] ?? sourceSystem}`,
    accountId: connection.id,
    scopes: 'composio managed',
    connectedByUserId,
  });
}
