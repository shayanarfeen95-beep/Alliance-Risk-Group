/**
 * Connecting a source, end to end, against a stubbed provider.
 *
 * The complaint this suite exists for was not "the numbers are wrong" — it was
 * that connecting a source appeared to do nothing. Two distinct failures were
 * behind that, and each gets a test here because each is invisible from the
 * outside:
 *
 *   1. A valid HubSpot token was reported as rejected, because the validity
 *      check asked an endpoint requiring a scope private apps do not have.
 *   2. A load that did succeed landed raw JSON and stopped. No fact table was
 *      touched, so every dashboard showed exactly what it showed before.
 *
 * The chain asserted here is the whole thing: verify the token, fetch, land,
 * conform, and find real rows in a fact table at the end.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as t from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { verifyHubspotToken } from '@/lib/connectors/hubspot-verify';
import { runSync } from '@/lib/etl/sync';
import { saveCredential } from '@/lib/connectors/credentials';
import { DIVISION_SEED } from '@/lib/divisions';

let harness: TestDb;
const realFetch = globalThis.fetch;

/** Anything not explicitly routed is a 404, so a stray call fails loudly. */
function stubHubspot(routes: Record<string, { status: number; body: unknown }>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match
      ? routes[match]!
      : { status: 404, body: { message: `unrouted: ${url}` } };

    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(async () => {
  harness = await createTestDb();
  await harness.db.insert(t.dimDivision).values(
    DIVISION_SEED.map((division) => ({
      divisionCode: division.divisionCode,
      divisionName: division.divisionName,
      lineOfBusiness: division.lineOfBusiness,
      legacyCodes: division.legacyCodes,
      qboClassIds: division.qboClassIds,
      primaryOperationalSystem: division.primaryOperationalSystem,
      sortOrder: division.sortOrder,
    })),
  );
  process.env.CREDENTIAL_KEY ??= 'dGVzdC1jcmVkZW50aWFsLWtleS0zMi1ieXRlcy1sb25nIQ==';
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await harness.close();
});

describe('verifying a HubSpot private-app token', () => {
  const OK = { status: 200, body: { results: [] } };

  it('accepts a token whose app lacks the oauth scope', async () => {
    // This is the exact shape that used to be rejected: every CRM scope the
    // connector needs is granted, and only /account-info — which needs `oauth`
    // — is refused. The token is fine. The old check said it was not.
    stubHubspot({
      '/crm/v3/objects/deals': OK,
      '/crm/v3/objects/contacts': OK,
      '/crm/v3/objects/meetings': OK,
      '/crm/v3/owners': OK,
      '/account-info/v3/details': { status: 403, body: { message: 'missing scope: oauth' } },
    });

    const check = await verifyHubspotToken('pat-na1-anything');
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    expect(check.portalId).toBeNull();
    expect(check.warnings).toEqual([]);
    expect(check.scopes.every((scope) => scope.granted)).toBe(true);
  });

  it('reads the portal id when the oauth scope happens to be there', async () => {
    stubHubspot({
      '/crm/v3/objects/deals': OK,
      '/crm/v3/objects/contacts': OK,
      '/crm/v3/objects/meetings': OK,
      '/crm/v3/owners': OK,
      '/account-info/v3/details': {
        status: 200,
        body: { portalId: 39587847, uiDomain: 'app.hubspot.com' },
      },
    });

    const check = await verifyHubspotToken('pat-na1-anything');
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.portalId).toBe('39587847');
  });

  it('distinguishes a bad token from a missing scope', async () => {
    stubHubspot({ '/crm/v3/objects/deals': { status: 401, body: { message: 'expired' } } });

    const invalid = await verifyHubspotToken('pat-na1-revoked');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    // The remedy is a new token, and the message has to say so — telling
    // somebody to check their scopes here wastes an afternoon.
    expect(invalid.error).toMatch(/not valid/i);
    expect(invalid.error).toMatch(/401/);

    stubHubspot({
      '/crm/v3/objects/deals': OK,
      '/crm/v3/objects/contacts': { status: 403, body: { message: 'missing scope' } },
      '/crm/v3/objects/meetings': OK,
      '/crm/v3/owners': OK,
    });

    const unscoped = await verifyHubspotToken('pat-na1-partial');
    expect(unscoped.ok).toBe(false);
    if (unscoped.ok) return;
    // The remedy here is a checkbox, and the message names it.
    expect(unscoped.error).toContain('crm.objects.contacts.read');
    expect(unscoped.error).not.toMatch(/not valid/i);
  });

  it('connects with a warning when only an optional scope is refused', async () => {
    stubHubspot({
      '/crm/v3/objects/deals': OK,
      '/crm/v3/objects/contacts': OK,
      '/crm/v3/objects/meetings': { status: 403, body: { message: 'missing scope' } },
      '/crm/v3/owners': OK,
      '/account-info/v3/details': { status: 403, body: {} },
    });

    const check = await verifyHubspotToken('pat-na1-mostly');
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    // Connected, and honest about what will not work.
    expect(check.warnings.join(' ')).toContain('crm.objects.meetings.read');
    expect(check.warnings.join(' ')).toMatch(/Meetings Completed/);
  });

  it('does not blame the token for a rate limit', async () => {
    stubHubspot({ '/crm/v3/objects/deals': { status: 429, body: { message: 'slow down' } } });

    const check = await verifyHubspotToken('pat-na1-anything');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatch(/rate-limited/i);
    expect(check.error).toMatch(/may be perfectly good/i);
  });
});

describe('a sync writes facts, not just raw payloads', () => {
  it('fetches, lands and conforms in one run', async () => {
    await saveCredential(
      {
        sourceSystem: 'HUBSPOT',
        authMethod: 'TOKEN',
        data: { accessToken: 'pat-na1-test' },
        accountLabel: 'Test portal',
      },
      harness.db,
    );

    stubHubspot({
      '/crm/v3/objects/deals': {
        status: 200,
        body: {
          results: [
            {
              id: '900',
              properties: {
                dealname: 'Statewide screening program',
                amount: '125000',
                dealstage: 'closedwon',
                pipeline: 'default',
                hs_is_closed_won: 'true',
                hs_is_closed: 'true',
                createdate: '2026-01-05T00:00:00Z',
                closedate: '2026-03-11T00:00:00Z',
                hubspot_owner_id: '55',
              },
              propertiesWithHistory: {
                dealstage: [
                  { value: 'qualifiedtobuy', timestamp: '2026-01-05T00:00:00Z' },
                  { value: 'proposalsent', timestamp: '2026-02-10T00:00:00Z' },
                  { value: 'closedwon', timestamp: '2026-03-11T00:00:00Z' },
                ],
              },
            },
          ],
        },
      },
    });

    const result = await runSync(harness.db, {
      sourceSystem: 'HUBSPOT',
      entity: 'deals',
      window: { start: '2026-01-01', end: '2026-03-01' },
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.rowsRead).toBe(1);

    // The raw payload is kept, so a conform fix can be replayed without
    // calling HubSpot again.
    expect(await harness.db.select().from(t.rawPayload)).toHaveLength(1);

    // And — the point of the whole exercise — the fact table is populated.
    // Before the conform step existed this was empty and every dashboard was
    // unchanged by a "successful" load.
    const deals = await harness.db.select().from(t.factDeal);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.dealName).toBe('Statewide screening program');
    expect(Number(deals[0]!.amount)).toBe(125000);
    expect(deals[0]!.enteredProposalAt?.toISOString()).toBe('2026-02-10T00:00:00.000Z');

    expect(await harness.db.select().from(t.factDealStageHistory)).toHaveLength(3);
    expect(result.tables).toContain('fact_deal');

    const [run] = await harness.db.select().from(t.loadRun);
    expect(run!.status).toBe('SUCCEEDED');
    expect(run!.rowsWritten).toBeGreaterThan(0);
  });

  it('records a provider refusal against the run and writes nothing', async () => {
    await saveCredential(
      {
        sourceSystem: 'HUBSPOT',
        authMethod: 'TOKEN',
        data: { accessToken: 'pat-na1-revoked' },
      },
      harness.db,
    );

    stubHubspot({ '/crm/v3/objects/deals': { status: 401, body: { message: 'expired' } } });

    const result = await runSync(harness.db, {
      sourceSystem: 'HUBSPOT',
      entity: 'deals',
      window: { start: '2026-03-01', end: '2026-03-01' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected the credential|401/i);
    expect(await harness.db.select().from(t.factDeal)).toHaveLength(0);

    const [run] = await harness.db.select().from(t.loadRun);
    expect(run!.status).toBe('FAILED');
    expect(run!.errorMessage).toBeTruthy();

    // The failure is recorded against the credential too, because the admin
    // screen is where somebody goes looking when a refresh stops working.
    const [credential] = await harness.db.select().from(t.connectorCredential);
    expect(credential!.status).toBe('ERROR');
    expect(credential!.lastError).toBeTruthy();
  });
});
