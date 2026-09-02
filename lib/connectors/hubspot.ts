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
  requestWithRetry,
  type EntityDescriptor,
  type FetchWindow,
  type RawBatch,
  type RawRecord,
  type SourceConnector,
} from './types';
import { isConnected, loadCredential } from './credentials';
import { proxy } from './composio';

const API = 'https://api.hubapi.com';

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

const MEETING_PROPERTIES = [
  'hs_meeting_start_time',
  'hs_meeting_outcome',
  'hs_meeting_title',
  'hubspot_owner_id',
];

const ENTITIES: EntityDescriptor[] = [
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

/** Walks HubSpot's cursor pagination to completion. */
async function fetchAll(
  path: string,
  properties: string[],
  extraParams: Record<string, string> = {},
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  let after: string | undefined;

  do {
    const json = await fetchPage(path, {
      limit: '100',
      properties: properties.join(','),
      archived: 'false',
      ...extraParams,
      ...(after ? { after } : {}),
    });

    for (const result of json.results) {
      records.push({ entity: path, key: result.id, payload: result });
    }
    after = json.paging?.next?.after;
  } while (after);

  return records;
}

export const hubspotConnector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot',

  entities: () => ENTITIES,

  isConfigured: () => isConnected('HUBSPOT'),

  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    if (!(await hubspotConnector.isConfigured())) throw new ConnectorNotConfiguredError('HUBSPOT');

    let records: RawRecord[];

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

        records = await fetchAll('/crm/v3/objects/deals', properties, {
          propertiesWithHistory: 'dealstage',
        });
        break;
      }
      case 'contacts':
        records = await fetchAll('/crm/v3/objects/contacts', CONTACT_PROPERTIES);
        break;
      case 'meetings':
        records = await fetchAll('/crm/v3/objects/meetings', MEETING_PROPERTIES, {
          associations: 'deals,contacts',
        });
        break;
      default:
        throw new Error(`Unknown HubSpot entity "${entity}".`);
    }

    return { sourceSystem: 'HUBSPOT', entity, window, records, fetchedAt: new Date() };
  },
};
