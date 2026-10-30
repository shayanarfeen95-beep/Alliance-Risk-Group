/**
 * The HubSpot fields Westport's leadership definitions name, found by label.
 *
 * "Line of Business", "Date Compliance Review Completed" and "Lead Source" are
 * custom fields: their internal names are whatever HubSpot generated. Asking for
 * a guessed name fails silently — HubSpot just returns nothing — so the
 * connector reads HubSpot's field list and asks for the field whose LABEL
 * matches. And because a "what changed" pull never returns a deal nobody has
 * touched, adding fields makes the next deals pull read every deal once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import * as t from '@/lib/db/schema';
import {
  LEADERSHIP_FIELDS,
  HUBSPOT_FIELDS_VERSION,
  findField,
  hasOption,
  readField,
  requestedNames,
} from '@/lib/connectors/hubspot-fields';

// --- A fake HubSpot ----------------------------------------------------------

const calls: Array<{ endpoint: string; method: string; query?: Record<string, string>; body?: unknown }> = [];

vi.mock('@/lib/connectors/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/credentials')>()),
  isConnected: async () => true,
  loadCredential: async () => ({ authMethod: 'COMPOSIO', data: { connectedAccountId: 'ca_test' } }),
}));

vi.mock('@/lib/connectors/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/composio')>()),
  proxy: async (request: { endpoint: string; method: string; query?: Record<string, string>; body?: unknown }) => {
    calls.push(request);
    if (request.endpoint === '/crm/v3/properties/deals') {
      return {
        results: [
          { name: 'dealname', label: 'Deal Name' },
          { name: 'lob__generated_77', label: 'Line of Business', type: 'enumeration', options: [{ label: 'Background Checks', value: 'bgc' }] },
          { name: 'date_cr_done', label: 'Date Compliance Review Completed', type: 'date' },
        ],
      };
    }
    if (request.endpoint === '/crm/v3/properties/contacts') {
      return { results: [{ name: 'contact_lead_source', label: 'Lead Source', type: 'enumeration' }] };
    }
    if (request.endpoint.endsWith('/search')) return { total: 0, results: [] };
    return { results: [] };
  },
}));

const { hubspotConnector } = await import('@/lib/connectors/hubspot');
const { readWatermark } = await import('@/lib/etl/ingest');

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  calls.length = 0;
});

describe('finding a field by its label', () => {
  const catalog = [
    { name: 'line_of_business_old', label: 'Line of Business (archived)' },
    { name: 'lob_x', label: 'Line of Business', options: [{ label: 'Background Checks', value: 'bgc' }, { label: 'Drug Testing', value: 'dt' }] },
  ];

  it('prefers the exact label over one that merely contains it', () => {
    expect(findField(LEADERSHIP_FIELDS.lineOfBusiness, catalog)?.name).toBe('lob_x');
  });

  it('asks for the guessed internal name only when the field list is unavailable', () => {
    expect(requestedNames('deals', catalog)).toContain('lob_x');
    expect(requestedNames('deals', null)).toContain('line_of_business');
  });

  it('reads an option back as its label, several joined', () => {
    expect(readField(LEADERSHIP_FIELDS.lineOfBusiness, { lob_x: 'bgc;dt' }, catalog)).toBe(
      'Background Checks; Drug Testing',
    );
    // An unknown value is kept rather than dropped: it is still what HubSpot holds.
    expect(readField(LEADERSHIP_FIELDS.lineOfBusiness, { lob_x: 'zzz' }, catalog)).toBe('zzz');
  });

  it('compares "is any of" per option, ignoring case and punctuation', () => {
    expect(hasOption('Background Checks; Drug Testing', 'Background Checks')).toBe(true);
    expect(hasOption('background_checks', 'Background Checks')).toBe(true);
    expect(hasOption('Drug Testing', 'Background Checks')).toBe(false);
    expect(hasOption(null, 'Background Checks')).toBe(false);
  });
});

describe('what the connector asks HubSpot for', () => {
  it('reads deals with the fields found by label, and who created each', async () => {
    await hubspotConnector.fetch('deals', { start: '2026-09-01', end: '2026-09-01' });
    const list = calls.find((call) => call.endpoint === '/crm/v3/objects/deals');
    const properties = list?.query?.properties?.split(',') ?? [];
    expect(properties).toEqual(expect.arrayContaining(['lob__generated_77', 'date_cr_done', 'hs_created_by_user_id']));
    expect(properties).not.toContain('line_of_business');
  });

  it('lands the field list with the object each field belongs to', async () => {
    const batch = await hubspotConnector.fetch('properties', { start: '2026-09-01', end: '2026-09-01' });
    expect(batch.records.find((record) => record.key === 'deals:lob__generated_77')?.payload).toMatchObject({
      objectType: 'deals',
      label: 'Line of Business',
    });
    expect(batch.records.some((record) => record.key === 'contacts:contact_lead_source')).toBe(true);
  });

  it('reads only contacts that entered MQL, with their lead source, on the first pass too', async () => {
    await hubspotConnector.fetch('mql_contacts', { start: '2026-09-01', end: '2026-09-01' });
    const search = calls.find((call) => call.endpoint === '/crm/v3/objects/contacts/search');
    const filters = (search?.body as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string }> }> })
      .filterGroups[0]!.filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ propertyName: 'hs_v2_date_entered_marketingqualifiedlead', operator: 'HAS_PROPERTY' }),
      ]),
    );
    // Or one of the SQL lead sources: the dated field is empty for most contacts.
    const bySource = (search?.body as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; values?: string[] }> }> })
      .filterGroups[1]!.filters;
    expect(bySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ propertyName: 'contact_lead_source', operator: 'IN', values: expect.arrayContaining(['Website', 'SHRM RFQ']) }),
      ]),
    );
  });
});

describe('a pull after the fields change', () => {
  it('reads every deal once, then goes back to only what changed', async () => {
    const watermark = new Date('2026-10-20T00:00:00Z');
    await harness.db.insert(t.syncState).values({
      sourceSystem: 'HUBSPOT',
      entity: 'deals',
      watermark,
      fieldsVersion: null,
    });
    // Read with fewer fields than now: the watermark no longer covers every deal.
    expect(await readWatermark(harness.db, 'HUBSPOT', 'deals')).toBeNull();

    await harness.db
      .update(t.syncState)
      .set({ fieldsVersion: HUBSPOT_FIELDS_VERSION.deals! });
    expect((await readWatermark(harness.db, 'HUBSPOT', 'deals'))?.toISOString()).toBe(watermark.toISOString());
  });

  it('leaves entities whose fields did not change incremental', async () => {
    const watermark = new Date('2026-10-21T00:00:00Z');
    await harness.db.insert(t.syncState).values({ sourceSystem: 'HUBSPOT', entity: 'meetings', watermark });
    expect((await readWatermark(harness.db, 'HUBSPOT', 'meetings'))?.toISOString()).toBe(watermark.toISOString());
  });
});
