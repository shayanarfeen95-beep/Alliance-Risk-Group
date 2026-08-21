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
import { loadHubspotMapping } from './hubspot-mapping';
import { getDb } from '@/lib/db/client';

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

async function token(): Promise<string> {
  const credential = await loadCredential('HUBSPOT');
  const value = credential?.data.accessToken;
  if (!value) throw new ConnectorNotConfiguredError('HUBSPOT');
  return value;
}

/**
 * Walks HubSpot's cursor pagination to completion.
 *
 * `entity` is the warehouse's name for the object — `deals`, not
 * `/crm/v3/objects/deals`. The landing table is queried by that name when a
 * mapping is re-applied, so storing the URL path there would make every landed
 * payload invisible to the conform step.
 */
async function fetchAll(
  entity: string,
  path: string,
  properties: string[],
  extraParams: Record<string, string> = {},
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  let after: string | undefined;

  do {
    const url = new URL(`${API}${path}`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('properties', properties.join(','));
    url.searchParams.set('archived', 'false');
    for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
    if (after) url.searchParams.set('after', after);

    const response = await requestWithRetry(
      url.toString(),
      { headers: { Authorization: `Bearer ${(await token())}`, Accept: 'application/json' } },
      'HUBSPOT',
    );

    const json = (await response.json()) as {
      results: Array<{ id: string }>;
      paging?: { next?: { after?: string } };
    };

    for (const result of json.results) {
      records.push({ entity, key: result.id, payload: result });
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
        // §14.3 open item 2: the division property is a Westport decision,
        // configured in Admin → HubSpot division mapping rather than in an
        // environment variable somebody has to redeploy to change. If it is
        // unset we still fetch the deals — they simply arrive unattributed, and
        // the KPI layer reports at ARG Total only rather than inventing a rule.
        const mapping = await loadHubspotMapping(await getDb());
        const properties =
          mapping.rule === 'deal_property' && mapping.property
            ? [...DEAL_PROPERTIES, mapping.property]
            : DEAL_PROPERTIES;

        records = await fetchAll('deals', '/crm/v3/objects/deals', properties, {
          propertiesWithHistory: 'dealstage',
        });
        break;
      }
      case 'contacts':
        records = await fetchAll('contacts', '/crm/v3/objects/contacts', CONTACT_PROPERTIES);
        break;
      case 'meetings':
        records = await fetchAll('meetings', '/crm/v3/objects/meetings', MEETING_PROPERTIES, {
          associations: 'deals,contacts',
        });
        break;
      default:
        throw new Error(`Unknown HubSpot entity "${entity}".`);
    }

    return { sourceSystem: 'HUBSPOT', entity, window, records, fetchedAt: new Date() };
  },
};
