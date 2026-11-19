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
import {
  CONTACT_MQL_ENTERED,
  DEAL_CREATED_BY,
  HUBSPOT_FIELDS_VERSION,
  LEADERSHIP_FIELDS,
  SQL_LEAD_SOURCES,
  findField,
  hasOption,
  requestedNames,
  type FieldSpec,
  type HubspotObjectType,
  type HubspotPropertyDefinition,
} from './hubspot-fields';

const API = 'https://api.hubapi.com';

/**
 * The property every incremental read hangs on.
 *
 * HubSpot stamps it on every object and updates it on every change, which makes
 * it the only field that can answer "what is new since last time" without
 * walking the whole portal to find out.
 */
const LAST_MODIFIED = 'hs_lastmodifieddate';

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
  // New business versus renewal/expansion. The filter leadership asked for, and
  // the distinction booked-versus-billed depends on.
  'dealtype',
  // Who created the deal — a user id. Deals created by month leaves one
  // user's deals out, by Westport's definition.
  DEAL_CREATED_BY,
  // How the business says the deal was sourced. Portals name this field
  // differently, so the candidates are tried in order and the first one present
  // on the record wins — see sourceLabel() in the conform step.
  ...DEAL_SOURCE_PROPERTIES,
  // Asked for explicitly so the FIRST full crawl can record a watermark. Without
  // it the pass that walks the whole portal would leave nothing behind, and the
  // next pull would walk it again.
  LAST_MODIFIED,
];

const CONTACT_PROPERTIES = [
  'lifecyclestage',
  'createdate',
  'hs_analytics_source',
  // Kept because a portal that populates them gives a cleaner answer than
  // history does. ARG's portal leaves every one of them empty — which is why
  // the MQL and SQL dates are derived from lifecyclestage history instead.
  'hs_lifecyclestage_lead_date',
  'hs_lifecyclestage_customer_date',
  // "Date entered Marketing Qualified Lead (Lifecycle Stage Pipeline)" — the
  // field Westport's SQL report filters on.
  CONTACT_MQL_ENTERED,
  LAST_MODIFIED,
];

const COMPANY_PROPERTIES = [
  'name',
  'domain',
  'hs_ideal_customer_profile',
  'lifecyclestage',
  LAST_MODIFIED,
];

const MEETING_PROPERTIES = [
  'hs_meeting_start_time',
  'hs_meeting_outcome',
  'hs_meeting_title',
  'hubspot_owner_id',
  // "Call and meeting type" — the axis the leadership review is read along.
  // Discovery calls and demos are values of this field, not separate objects.
  'hs_activity_type',
  LAST_MODIFIED,
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
/**
 * Stages are loaded before deals, and before everything else.
 *
 * A stage id is opaque and portal-specific — ARG's Proposal stage is
 * `presentationscheduled` and its Compliance Review stage is `1383067404` — so
 * conforming a deal cannot tell which stage it reached without the labels
 * already in place.
 */
const STAGE_ENTITY: EntityDescriptor = {
  entity: 'deal_stages',
  label: 'Deal stages and pipelines',
  cadence: 'WEEKLY',
  description:
    'The names behind HubSpot\'s opaque stage ids. Without these, "reached the Proposal stage" cannot be evaluated at all.',
};


/**
 * HubSpot's field list, read before anything that depends on it.
 *
 * Westport's definitions name fields by label — "Line of Business", "Date
 * Compliance Review Completed", "Lead Source" — and custom fields have
 * generated internal names. Deals and contacts are read with whatever names
 * these labels resolve to, and the import translates option values back to
 * the labels people see.
 */
const PROPERTIES_ENTITY: EntityDescriptor = {
  entity: 'properties',
  label: 'Field definitions',
  cadence: 'WEEKLY',
  description:
    "HubSpot's list of deal and contact fields, so Line of Business, Date Compliance Review Completed and Lead Source are found by the names Westport uses for them.",
};

const ENTITIES: EntityDescriptor[] = [
  PROPERTIES_ENTITY,
  STAGE_ENTITY,
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
    entity: 'mql_contacts',
    label: 'Marketing qualified leads',
    cadence: 'DAILY',
    description:
      'Contacts that have entered Marketing Qualified Lead, with their Lead Source — what SQLs per month is counted on. Read on their own so the review does not wait on a re-read of every contact.',
  },
  {
    entity: 'meetings',
    label: 'Meetings (engagements)',
    cadence: 'DAILY',
    description: 'Meetings Completed, by meeting date in period.',
  },
  {
    entity: 'companies',
    label: 'Companies (with ICP tier)',
    cadence: 'WEEKLY',
    description:
      'Ideal Customer Profile tier lives on the company, not the deal, so average deal size by ICP cannot be answered without it.',
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


/** The newest `hs_lastmodifieddate` across a batch of landed records. */
function latestModified(records: RawRecord[]): Date | null {
  let newest: Date | null = null;
  for (const record of records) {
    const properties = (record.payload as HubspotRecord | undefined)?.properties;
    // Contacts historically answer to the unprefixed spelling; both are read so
    // a watermark is recorded whichever one this object carries.
    const value = properties?.hs_lastmodifieddate ?? properties?.lastmodifieddate;
    if (!value) continue;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) continue;
    if (!newest || parsed > newest) newest = parsed;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/** Read once per object per few minutes: a pull asks for it on every slice. */
const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map<HubspotObjectType, { at: number; fields: HubspotPropertyDefinition[] }>();

/** HubSpot's field list for an object. Throws when it cannot be read. */
async function readCatalog(object: HubspotObjectType): Promise<HubspotPropertyDefinition[]> {
  const cached = catalogCache.get(object);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.fields;

  const page = await fetchPage(`/crm/v3/properties/${object}`, {});
  if (!Array.isArray(page.results)) {
    throw new Error(`HubSpot returned no field list for ${object}.`);
  }
  const fields = page.results as unknown as HubspotPropertyDefinition[];
  catalogCache.set(object, { at: Date.now(), fields });
  return fields;
}

/**
 * The field list, or null when it cannot be read.
 *
 * A deals pull must not fail because the field list is unavailable: it falls
 * back to the likely internal names, and the field-definitions step — which
 * does fail loudly — says why in the pull log.
 */
async function catalogOrNull(object: HubspotObjectType): Promise<HubspotPropertyDefinition[] | null> {
  try {
    return await readCatalog(object);
  } catch {
    return null;
  }
}

async function dealProperties(): Promise<string[]> {
  const divisionProperty = process.env.HUBSPOT_DIVISION_PROPERTY;
  const leadership = requestedNames('deals', await catalogOrNull('deals'));
  return [
    ...new Set([...DEAL_PROPERTIES, ...leadership, ...(divisionProperty ? [divisionProperty] : [])]),
  ];
}

interface SearchFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}

/** Who can be an SQL: a date entered MQL, or one of the SQL lead sources. */
async function sqlCandidateFilters(): Promise<SearchFilter[][]> {
  const groups: SearchFilter[][] = [[{ propertyName: CONTACT_MQL_ENTERED, operator: 'HAS_PROPERTY' }]];
  const catalog = await catalogOrNull('contacts');
  const field = findField(LEADERSHIP_FIELDS.contactLeadSource, catalog);
  if (!field) return groups;
  const options = field.options ?? [];
  // HubSpot filters on an option's internal value; Westport named its label.
  const values = options.length
    ? options
        .filter((option) => SQL_LEAD_SOURCES.some((source) => hasOption(option.label ?? '', source)))
        .map((option) => option.value)
        .filter((value): value is string => Boolean(value))
    : SQL_LEAD_SOURCES;
  if (values.length) groups.push([{ propertyName: field.name, operator: 'IN', values }]);
  return groups;
}

async function contactProperties(): Promise<string[]> {
  const leadership = requestedNames('contacts', await catalogOrNull('contacts'));
  return [...new Set([...CONTACT_PROPERTIES, ...leadership])];
}

// ---------------------------------------------------------------------------
// Incremental reads
// ---------------------------------------------------------------------------

/**
 * What an incremental slice is resuming from.
 *
 * HubSpot's search endpoint caps a single query at ten thousand results however
 * far you page it. Sorting ascending by modification time makes that survivable:
 * when a query is exhausted, the next one starts from the last timestamp seen
 * rather than from the beginning. So a cursor has to carry both halves — where
 * the current query is, and where to restart it.
 */
interface IncrementalCursor {
  /** Epoch milliseconds; the exclusive lower bound of the current query. */
  since: number;
  /** HubSpot's paging token within that query, if there is one. */
  after?: string;
}

function parseCursor(raw: string | null | undefined): IncrementalCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IncrementalCursor>;
    if (typeof parsed.since === 'number') {
      return { since: parsed.since, after: parsed.after };
    }
  } catch {
    // A plain token is a cursor from a full crawl, not an incremental one.
  }
  return null;
}

interface SearchPage {
  total?: number;
  results?: Array<{ id: string; properties?: Record<string, string | null> }>;
  paging?: { next?: { after?: string } };
}

/** POSTs through whichever transport this connection uses. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const credential = await loadCredential('HUBSPOT');
  if (!credential) throw new ConnectorNotConfiguredError('HUBSPOT');

  if (credential.authMethod === 'COMPOSIO') {
    const connectedAccountId = credential.data.connectedAccountId;
    if (!connectedAccountId) throw new ConnectorNotConfiguredError('HUBSPOT');
    return proxy<T>({
      connectedAccountId,
      endpoint: path,
      method: 'POST',
      headers: { accept: 'application/json' },
      body,
    });
  }

  const accessToken = credential.data.accessToken;
  if (!accessToken) throw new ConnectorNotConfiguredError('HUBSPOT');

  const response = await requestWithRetry(
    `${API}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'HUBSPOT',
  );
  return (await response.json()) as T;
}

/**
 * Everything that changed since a moment, in three steps.
 *
 * Search finds the ids and nothing else — it returns neither property history
 * nor associations, so it cannot be the whole answer. Batch read fills in the
 * properties and the history; a second batch call fills in associations. Three
 * round trips per hundred records rather than one, which is still a fraction of
 * the cost of walking a portal that has not changed.
 */
async function fetchChanged(
  object: string,
  properties: string[],
  options: FetchOptions | undefined,
  config: {
    withHistory?: string[];
    associateTo?: string;
    pageSize?: number;
    /**
     * Conditions a record must meet, ANDed with the watermark. Each inner list
     * is one alternative: a record matching any of them is read.
     */
    filterGroups?: SearchFilter[][];
  } = {},
): Promise<{ records: RawRecord[]; nextCursor: string | null; watermark: Date | null }> {
  const path = `/crm/v3/objects/${object}`;
  const pageSize = config.pageSize ?? 100;

  const resumed = parseCursor(options?.cursor);
  let since = resumed?.since ?? options?.since?.getTime() ?? 0;
  let after = resumed?.after;

  const records: RawRecord[] = [];
  let watermark: Date | null = null;

  for (;;) {
    const page = await post<SearchPage>(`${path}/search`, {
      filterGroups: (config.filterGroups?.length ? config.filterGroups : [[]]).map((group) => ({
        filters: [
          { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(since) },
          ...group,
        ],
      })),
      // Ascending, so an exhausted query can be restarted from the last record
      // rather than from the beginning.
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: ['hs_lastmodifieddate'],
      limit: pageSize,
      ...(after ? { after } : {}),
    });

    const hits = page.results ?? [];
    if (hits.length === 0) return { records, nextCursor: null, watermark };

    const ids = hits.map((hit) => hit.id);
    const hydrated = await batchRead(object, ids, properties, config.withHistory);

    if (config.associateTo) {
      const associations = await batchAssociations(object, config.associateTo, ids);
      for (const record of hydrated) {
        const to = associations.get(record.id);
        if (to?.length) {
          record.associations = {
            ...(record.associations ?? {}),
            [config.associateTo]: { results: to.map((id) => ({ id })) },
          };
        }
      }
    }

    for (const record of hydrated) {
      records.push({ entity: path, key: record.id, payload: record });
    }

    for (const hit of hits) {
      const modified = hit.properties?.hs_lastmodifieddate;
      const parsed = modified ? new Date(modified) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        if (!watermark || parsed > watermark) watermark = parsed;
      }
    }

    after = page.paging?.next?.after;

    if (!after) {
      // Either the query is finished, or it hit HubSpot's ten-thousand cap. The
      // two are indistinguishable from here, so if the total says there is more,
      // restart from the last timestamp seen rather than declaring done.
      const more = (page.total ?? 0) > records.length && watermark;
      if (!more) return { records, nextCursor: null, watermark };

      since = watermark!.getTime();
      if (budgetSpent(options, records.length)) {
        return { records, nextCursor: JSON.stringify({ since }), watermark };
      }
      continue;
    }

    if (budgetSpent(options, records.length)) {
      return { records, nextCursor: JSON.stringify({ since, after }), watermark };
    }
  }
}

interface HubspotRecord {
  id: string;
  properties?: Record<string, string | null>;
  propertiesWithHistory?: Record<string, Array<{ value?: string; timestamp?: string }>>;
  associations?: Record<string, { results?: Array<{ id: string }> }>;
}

async function batchRead(
  object: string,
  ids: string[],
  properties: string[],
  withHistory?: string[],
): Promise<HubspotRecord[]> {
  const page = await post<{ results?: HubspotRecord[] }>(
    `/crm/v3/objects/${object}/batch/read`,
    {
      inputs: ids.map((id) => ({ id })),
      ...(properties.length ? { properties } : {}),
      ...(withHistory?.length ? { propertiesWithHistory: withHistory } : {}),
    },
  );
  return page.results ?? [];
}

async function batchAssociations(
  from: string,
  to: string,
  ids: string[],
): Promise<Map<string, string[]>> {
  const page = await post<{
    results?: Array<{ from?: { id?: string }; to?: Array<{ toObjectId?: number | string }> }>;
  }>(`/crm/v4/associations/${from}/${to}/batch/read`, { inputs: ids.map((id) => ({ id })) });

  const map = new Map<string, string[]>();
  for (const row of page.results ?? []) {
    const fromId = row.from?.id;
    if (!fromId) continue;
    map.set(
      fromId,
      (row.to ?? []).map((entry) => String(entry.toObjectId)).filter(Boolean),
    );
  }
  return map;
}


/**
 * The entities worth asking "what changed" about, and how.
 *
 * Owners, stages and pipelines are absent deliberately. They are tens of rows,
 * they change when somebody reorganises the sales team, and a search-plus-batch
 * round trip costs more than reading them whole. Reference data is re-read every
 * time; only the facts are incremental.
 */
const INCREMENTAL_ENTITIES: Record<
  string,
  {
    object: string;
    properties: () => Promise<string[]>;
    withHistory?: string[];
    associateTo?: string;
    filterGroups?: () => Promise<SearchFilter[][]>;
  }
> = {
  deals: {
    object: 'deals',
    properties: dealProperties,
    withHistory: ['dealstage'],
    associateTo: 'companies',
  },
  contacts: {
    object: 'contacts',
    properties: contactProperties,
    withHistory: ['lifecyclestage'],
  },
  // The contacts an SQL can be: those with HubSpot's date entered MQL, and
  // those whose Lead Source is one of the SQL sources (whose MQL date may only
  // be in lifecycle history — the dated field is empty for most contacts in
  // this portal). Their first pass reads every one of them rather than the
  // whole portal; every pass after that reads only those changed since.
  mql_contacts: {
    object: 'contacts',
    properties: contactProperties,
    withHistory: ['lifecyclestage'],
    filterGroups: sqlCandidateFilters,
  },
  meetings: {
    object: 'meetings',
    properties: async () => MEETING_PROPERTIES,
    associateTo: 'deals',
  },
  companies: {
    object: 'companies',
    properties: async () => COMPANY_PROPERTIES,
  },
};

/**
 * Entities read through search even on their first pass.
 *
 * The list endpoint cannot filter, and these are defined by a filter.
 */
const SEARCH_ONLY = new Set(['mql_contacts']);

export const hubspotConnector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot',

  entities: () => ENTITIES,

  isConfigured: () => isConnected('HUBSPOT'),

  fieldsVersion: (entity: string) => HUBSPOT_FIELDS_VERSION[entity] ?? null,

  async fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch> {
    if (!(await hubspotConnector.isConfigured())) throw new ConnectorNotConfiguredError('HUBSPOT');

    let page: { records: RawRecord[]; nextCursor: string | null; watermark?: Date | null };

    /**
     * Incremental once there is a watermark, or once a slice is resuming one.
     *
     * The first pass of an entity is a full crawl: the list endpoint returns
     * associations inline and is not rate-limited the way search is, so walking
     * a portal once is cheaper that way than asking "what changed since the
     * beginning of time". Every pass after it asks only for changes.
     */
    const incremental =
      INCREMENTAL_ENTITIES[entity] !== undefined &&
      (SEARCH_ONLY.has(entity) ||
        options?.since != null ||
        (options?.cursor?.startsWith('{') ?? false));

    if (incremental) {
      const config = INCREMENTAL_ENTITIES[entity]!;
      const changed = await fetchChanged(config.object, await config.properties(), options, {
        withHistory: config.withHistory,
        associateTo: config.associateTo,
        pageSize: config.withHistory?.length ? HISTORY_PAGE_SIZE : DEFAULT_PAGE_SIZE,
        filterGroups: config.filterGroups ? await config.filterGroups() : undefined,
      });

      return {
        sourceSystem: 'HUBSPOT',
        entity,
        window,
        records: changed.records,
        fetchedAt: new Date(),
        nextCursor: changed.nextCursor,
        watermark: changed.watermark,
      };
    }

    switch (entity) {
      case 'deals': {
        // §14.3 open item 2: the division property is confirmed with Westport in
        // week 1. If it is unset we still fetch the deals — we simply cannot
        // attribute them to a division, and the KPI layer reports at ARG Total
        // only rather than inventing an attribution rule.
        page = await fetchPaged(
          '/crm/v3/objects/deals',
          await dealProperties(),
          { propertiesWithHistory: 'dealstage', associations: 'companies' },
          options,
          // HubSpot caps a page at 50 when property history is requested, and
          // rejects the whole call above that — it does not quietly truncate.
          // Asking for 100 made every deals page a VALIDATION_ERROR.
          HISTORY_PAGE_SIZE,
        );
        break;
      }
      case 'contacts':
        // History, because the hs_lifecyclestage_*_date properties are empty in
        // this portal — every one of them, across every contact. The date a
        // contact became an MQL exists only as a transition in this property's
        // history, so asking for it is the only way to count MQLs by month.
        // It caps the page at 50, as it does for deals.
        page = await fetchPaged(
          '/crm/v3/objects/contacts',
          await contactProperties(),
          { propertiesWithHistory: 'lifecyclestage' },
          options,
          HISTORY_PAGE_SIZE,
        );
        break;
      case 'companies':
        page = await fetchPaged('/crm/v3/objects/companies', COMPANY_PROPERTIES, {}, options);
        break;
      case 'meetings':
        page = await fetchPaged(
          '/crm/v3/objects/meetings',
          MEETING_PROPERTIES,
          { associations: 'deals,contacts' },
          options,
        );
        break;
      case 'properties': {
        // Read fresh, not from the cache: this step is how a renamed or newly
        // created field reaches the next deals pull.
        catalogCache.clear();
        const records: RawRecord[] = [];
        // Only the fields the review is defined on: HubSpot's whole field
        // list is hundreds of definitions with their options, and landing it
        // on every pull would fill the warehouse with reference data nobody
        // reads.
        const specs = Object.values(LEADERSHIP_FIELDS) as FieldSpec[];
        for (const object of ['deals', 'contacts'] as const) {
          const wanted = (await readCatalog(object)).filter((field) =>
            specs.some((spec) => spec.object === object && findField(spec, [field]) !== null),
          );
          for (const field of wanted) {
            records.push({
              entity: `/crm/v3/properties/${object}`,
              key: `${object}:${field.name}`,
              payload: { ...field, objectType: object },
            });
          }
        }
        page = { records, nextCursor: null };
        break;
      }
      case 'deal_stages': {
        // Not an object route: /crm/v3/pipelines returns every pipeline with its
        // stages inline, so there is nothing to paginate and no cursor to carry.
        const pipelines = await fetchPage('/crm/v3/pipelines/deals', {});
        page = {
          records: (pipelines.results ?? []).map((pipeline) => ({
            entity: '/crm/v3/pipelines/deals',
            key: (pipeline as { id: string }).id,
            payload: pipeline,
          })),
          nextCursor: null,
        };
        break;
      }
      case 'owners': {
        // The owners endpoint is not a CRM object route: it returns whole
        // records rather than a `properties` bag, and takes no properties
        // parameter. Asking it for one is a 400.
        const active = await fetchPaged('/crm/v3/owners', [], {}, options);
        if (active.nextCursor) {
          // Still walking the active list; the archived pass follows once it ends.
          page = active;
          break;
        }
        // And the people who have left. HubSpot returns only active users
        // unless asked otherwise, so every deal still owned by a former
        // employee had an owner id with no name behind it and was shown as
        // "Unassigned" — which reads as nobody owning it. The list is short,
        // so it is read whole rather than sliced.
        const archived = await fetchPaged('/crm/v3/owners', [], { archived: 'true' });
        page = { records: [...active.records, ...archived.records], nextCursor: null };
        break;
      }
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
      // A full crawl reports one too, so the pass that walks the portal once is
      // also the pass that makes every later pass incremental.
      watermark: page.watermark ?? latestModified(page.records),
    };
  },
};
