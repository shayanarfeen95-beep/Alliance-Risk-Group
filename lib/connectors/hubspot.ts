/**
 * HubSpot connector — §5.2.
 *
 * Read-only, like QBO. Deals, contacts and meetings land at their natural grain;
 * nothing is pre-aggregated on load, because ARG will want to slice by owner,
 * source and pipeline stage (§4.6).
 *
 * Deal stage history is fetched with `propertiesWithHistory`, because New
 * Proposals Sent needs the timestamp a deal ENTERED the Proposal stage, not its
 * current stage.
 */
import {
  ConnectorNotConfiguredError,
  budgetSpent,
  requestWithRetry,
  type EntityDescriptor,
  type FetchOptions,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
} from './types';
import { isConnected, loadCredential } from './credentials';
import { proxy } from './composio';

const API = 'https://api.hubapi.com';

/**
 * Candidate property names for "how did this deal come to us".
 *
 * There is no standard HubSpot field for it. ARG records it on `zoho_lead_source`
 * — carried over from the CRM they migrated from — while a portal set up inside
 * HubSpot would use `deal_source`. Asking for all of them costs nothing: HubSpot
 * omits properties a portal does not have rather than failing the request.
 */
const DEAL_SOURCE_PROPERTIES = ['zoho_lead_source', 'deal_source', 'lead_source'];

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
  // How the business says the deal was sourced. Portals name this field
  // differently, so the candidates are tried in order and the first one present
  // on the record wins — see sourceLabel() in the conform step.
  ...DEAL_SOURCE_PROPERTIES,
];

const CONTACT_PROPERTIES = [
  'lifecyclestage',
  'createdate',
  'hs_analytics_source',
  'hs_lifecyclestage_lead_date',
  'hs_lifecyclestage_customer_date',
];

const MEETING_PROPERTIES = [
  'hs_meeting_start_time',
  'hs_meeting_outcome',
  'hs_meeting_title',
  'hubspot_owner_id',
  // "Call and meeting type" — the axis the leadership review is read along.
  // Discovery calls and demos are values of this field, not separate objects.
  'hs_activity_type',
];

/**
 * Order matters here, and it is not cosmetic.
 *
 * Owners are listed first because conforming a deal looks its owner's name up
 * from the owners already landed. A pull that took deals first would write every
 * row as "Unassigned" — and on a first-ever load, which is the only load where
 * nothing is there to fall back on, the salesperson leaderboard would come up as
 * a single meaningless line and stay that way until somebody pulled again.
 *
 * Reference data before the facts that read it. Everything downstream of this
 * list — the plan the Pull button drives, the scheduled refresh, the agent —
 * takes its order from here.
 */
const ENTITIES: EntityDescriptor[] = [
  {
    entity: 'owners',
    label: 'Owners (salespeople)',
    cadence: 'WEEKLY',
    description:
      'The people deals are assigned to. Without them a deal carries an owner id and no name, and the salesperson leaderboard reads every row as Unassigned.',
  },
  {
    entity: 'deals',
    label: 'Deals (with stage history)',
    cadence: 'DAILY',
    description:
      'Bookings, pipeline and close time. Stage history is included because New Proposals Sent needs the entry timestamp, not the current stage.',
  },
  {
    entity: 'contacts',
    label: 'Contacts',
    cadence: 'DAILY',
    description: 'Leads by the date they became a lead, and original source for CPL by channel.',
  },
  {
    entity: 'meetings',
    label: 'Meetings (engagements)',
    cadence: 'DAILY',
    description: 'Meetings Completed, by meeting date in period.',
  },
];

/** HubSpot's maximum page size for an ordinary object read. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * The maximum when `propertiesWithHistory` is requested.
 *
 * HubSpot refuses the request outright above this — "You can only request at
 * most 50 objects in one request for properties with history" — rather than
 * returning fewer. Deals are the only entity that asks for history.
 */
const HISTORY_PAGE_SIZE = 50;

interface HubspotPage {
  results: Array<{ id: string }>;
  paging?: { next?: { after?: string } };
}

/**
 * One page from HubSpot, however the connection was authorised.
 *
 * The Composio path sends the identical request to the identical endpoint; the
 * only difference is that the bearer token is attached on Composio's side, so
 * no HubSpot credential exists in this process to be logged, cached or leaked.
 */
async function fetchPage(
  path: string,
  query: Record<string, string>,
): Promise<HubspotPage> {
  const credential = await loadCredential('HUBSPOT');
  if (!credential) throw new ConnectorNotConfiguredError('HUBSPOT');

  if (credential.authMethod === 'COMPOSIO') {
    const connectedAccountId = credential.data.connectedAccountId;
    if (!connectedAccountId) throw new ConnectorNotConfiguredError('HUBSPOT');

    const page = await proxy<HubspotPage>({
      connectedAccountId,
      endpoint: path,
      method: 'GET',
      query,
      headers: { accept: 'application/json' },
    });
    return { results: page.results ?? [], paging: page.paging };
  }

  const accessToken = credential.data.accessToken;
  if (!accessToken) throw new ConnectorNotConfiguredError('HUBSPOT');

  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const response = await requestWithRetry(
    url.toString(),
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    'HUBSPOT',
  );

  return (await response.json()) as HubspotPage;
}

/**
 * Walks HubSpot's cursor pagination for as long as the budget allows.
 *
 * A portal with thirty thousand contacts is three hundred round trips, and no
 * serverless invocation survives that. So this stops on the page boundary once
 * the deadline passes and hands the caller HubSpot's own `after` token: the next
 * slice picks up exactly where this one stopped, with no page fetched twice and
 * none skipped. Every record already read is returned and written — a slice that
 * runs out of time is progress, not a failure.
 */
async function fetchPaged(
  path: string,
  properties: string[],
  extraParams: Record<string, string> = {},
  options?: FetchOptions,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<{ records: RawRecord[]; nextCursor: string | null }> {
  const records: RawRecord[] = [];
  let after: string | undefined = options?.cursor ?? undefined;

  for (;;) {
    const json = await fetchPage(path, {
      limit: String(pageSize),
      // Omitted rather than sent empty: /crm/v3/owners is not an object route
      // and rejects a properties parameter outright.
      ...(properties.length ? { properties: properties.join(',') } : {}),
      archived: 'false',
      ...extraParams,
      ...(after ? { after } : {}),
    });

    // A page with no `results` array is not an empty page — it is a response
    // this code does not understand, and treating the two alike is how a refused
    // request came to be recorded as zero deals under a green tick.
    if (!Array.isArray(json.results)) {
      throw new Error(
        `HubSpot returned no result set for ${path}, so the pull was stopped rather than ` +
          `recorded as empty. The response was: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }

    for (const result of json.results) {
      records.push({ entity: path, key: result.id, payload: result });
    }

    after = json.paging?.next?.after;
    if (!after) return { records, nextCursor: null };
    if (budgetSpent(options, records.length)) return { records, nextCursor: after };
  }
}

export const hubspotConnector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot',

  entities: () => ENTITIES,

  isConfigured: () => isConnected('HUBSPOT'),

  async fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch> {
    if (!(await hubspotConnector.isConfigured())) throw new ConnectorNotConfiguredError('HUBSPOT');

    let page: { records: RawRecord[]; nextCursor: string | null };

    switch (entity) {
      case 'deals': {
        // §14.3 open item 2: the division property is confirmed with Westport in
        // week 1. If it is unset we still fetch the deals — we simply cannot
        // attribute them to a division, and the KPI layer reports at ARG Total
        // only rather than inventing an attribution rule.
        const divisionProperty = process.env.HUBSPOT_DIVISION_PROPERTY;
        const properties = divisionProperty
          ? [...DEAL_PROPERTIES, divisionProperty]
          : DEAL_PROPERTIES;

        page = await fetchPaged(
          '/crm/v3/objects/deals',
          properties,
          { propertiesWithHistory: 'dealstage' },
          options,
          // HubSpot caps a page at 50 when property history is requested, and
          // rejects the whole call above that — it does not quietly truncate.
          // Asking for 100 made every deals page a VALIDATION_ERROR.
          HISTORY_PAGE_SIZE,
        );
        break;
      }
      case 'contacts':
        page = await fetchPaged('/crm/v3/objects/contacts', CONTACT_PROPERTIES, {}, options);
        break;
      case 'meetings':
        page = await fetchPaged(
          '/crm/v3/objects/meetings',
          MEETING_PROPERTIES,
          { associations: 'deals,contacts' },
          options,
        );
        break;
      case 'owners':
        // The owners endpoint is not a CRM object route: it returns whole
        // records rather than a `properties` bag, and takes no properties
        // parameter. Asking it for one is a 400.
        page = await fetchPaged('/crm/v3/owners', [], {}, options);
        break;
      default:
        throw new Error(`Unknown HubSpot entity "${entity}".`);
    }

    return {
      sourceSystem: 'HUBSPOT',
      entity,
      window,
      records: page.records,
      fetchedAt: new Date(),
      nextCursor: page.nextCursor,
    };
  },
};
