/**
 * Booked against billed, account by account — and an assistant that cannot
 * state a figure no tool returned.
 *
 * Westport, November 2026: "determine which accounts have started billing in
 * QuickBooks compared to what is closed/won", with live progress against what
 * an account is expected to bill over twelve months. And: the assistant quoted
 * a $786,338 receivables total and "32 other won deals … $1,027,400" with no
 * tool behind them.
 *
 * The fixture is built so each rule has one account that exercises it:
 *   Acme     — matched by domain; billing includes a sub-customer and nets a
 *              credit memo; behind a straight-line year.
 *   Beta     — matched by name (no shared domain); ahead of pace.
 *   Gamma    — only a loose name similarity: suggested, never counted.
 *   Delta    — no QuickBooks customer at all.
 *   Omega    — matched, live three months, nothing billed: an alert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, domainOf } from '@/lib/etl/conform';
import { openSemanticSession } from '@/lib/semantic/resolve';
import {
  decideAccountMatch,
  loadAccountBilling,
  normaliseName,
  type AccountBillingRow,
} from '@/lib/billing/accounts';
import { statedFigures, unsupportedFigures } from '@/lib/ai/figure-check';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let user: SessionUser;
let runId: string;

// The agent reads the database it is given through getDb; point it at the test one.
vi.mock('@/lib/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/client')>()),
  getDb: async () => harness.db,
}));

const ASOF = new Date('2026-11-01T00:00:00Z');
const WON_FROM = new Date('2026-06-01T00:00:00Z');
const WON_TO = new Date('2026-11-01T00:00:00Z');

function hubspot(entity: string, payloads: unknown[]): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity,
    window: { start: '2026-08-01', end: '2026-08-01' },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({ entity: `/crm/v3/objects/${entity}`, key: String(index), payload })),
  };
}

function qbo(entity: string, payloads: unknown[]): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity,
    window: { start: '2026-08-01', end: '2026-08-01' },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({ entity, key: `p${index}`, payload })),
  };
}

const deal = (id: string, company: string, amount: string, closed: string) => ({
  id,
  properties: {
    dealname: `${id} - New Deal`,
    amount,
    dealstage: 'closedwon',
    pipeline: 'default',
    hs_is_closed_won: 'true',
    hs_is_closed: 'true',
    createdate: '2026-05-01T00:00:00Z',
    closedate: `${closed}T12:00:00Z`,
    hubspot_owner_id: '501',
  },
  associations: { companies: { results: [{ id: company }] } },
});

const invoice = (id: string, customer: string, date: string, total: number, tax = 0) => ({
  Id: id,
  DocNumber: `D${id}`,
  TxnDate: date,
  CustomerRef: { value: customer, name: customer },
  TotalAmt: total,
  Balance: 0,
  TxnTaxDetail: { TotalTax: tax },
  MetaData: { LastUpdatedTime: `${date}T09:00:00-07:00` },
});

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  const [run] = await harness.db.select({ id: t.loadRun.id }).from(t.loadRun).limit(1);
  runId = run!.id;

  await harness.db.insert(t.rawPayload).values({
    loadRunId: runId,
    sourceSystem: 'HUBSPOT',
    entity: '/crm/v3/owners',
    payload: { id: '501', userId: 9001, firstName: 'Mario', lastName: 'Pecoraro' },
  });

  await conformBatch(harness.db, runId, hubspot('companies', [
    { id: 'co1', properties: { name: 'Acme Logistics, Inc.', domain: 'acme.com' } },
    { id: 'co2', properties: { name: 'Beta Health', domain: 'beta.org' } },
    { id: 'co3', properties: { name: 'Gamma Partners', domain: 'gamma.io' } },
    { id: 'co4', properties: { name: 'Delta Corp' } },
    { id: 'co5', properties: { name: 'Omega Systems' } },
  ]));

  await conformBatch(harness.db, runId, hubspot('deals', [
    deal('Acme', 'co1', '120000', '2026-08-01'),
    deal('Beta', 'co2', '60000', '2026-09-15'),
    deal('Gamma', 'co3', '50000', '2026-08-10'),
    deal('Delta', 'co4', '30000', '2026-06-01'),
    deal('Omega', 'co5', '40000', '2026-08-01'),
  ]));

  await conformBatch(harness.db, runId, qbo('customers', [
    {
      QueryResponse: {
        Customer: [
          { Id: 'C1', DisplayName: 'Acme Logistics', WebAddr: { URI: 'https://www.acme.com' } },
          { Id: 'C1a', DisplayName: 'Warehouse', FullyQualifiedName: 'Acme Logistics:Warehouse', ParentRef: { value: 'C1' }, Job: true },
          { Id: 'C2', DisplayName: 'Beta Health LLC', PrimaryEmailAddr: { Address: 'ap@betahealth.net' } },
          { Id: 'C3', DisplayName: 'Gamma Partners Group' },
          { Id: 'C5', DisplayName: 'Omega Systems', PrimaryEmailAddr: { Address: 'omega@gmail.com' } },
          { Id: 'C9', DisplayName: 'Zeta Ltd' },
        ],
      },
    },
  ]));

  await conformBatch(harness.db, runId, qbo('invoices', [
    {
      kind: 'Invoice',
      rows: [
        invoice('1', 'C1', '2026-03-01', 5000),
        invoice('2', 'C1', '2026-08-15', 10000),
        invoice('3', 'C1a', '2026-09-15', 10500, 500),
        invoice('4', 'C2', '2026-10-01', 10000),
        invoice('5', 'C9', '2026-10-01', 99999),
      ],
    },
    { kind: 'CreditMemo', rows: [invoice('7', 'C1', '2026-10-01', 2000)] },
  ]));
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

async function billing() {
  const session = await openSemanticSession(harness.db, user, '2026-10-01');
  return loadAccountBilling(harness.db, session, { wonFrom: WON_FROM, wonTo: WON_TO, asOf: ASOF });
}

const row = (rows: AccountBillingRow[], account: string) => rows.find((r) => r.account.startsWith(account))!;

describe('QuickBooks billing by customer', () => {
  it('reads domains from websites and email, ignoring mailbox providers', async () => {
    expect(domainOf('https://www.Acme.com/about')).toBe('acme.com');
    expect(domainOf('ap@betahealth.net')).toBe('betahealth.net');
    const [omega] = await harness.db
      .select({ email: t.dimQboCustomer.emailDomain })
      .from(t.dimQboCustomer)
      .where((await import('drizzle-orm')).eq(t.dimQboCustomer.customerId, 'C5'));
    expect(omega?.email).toBeNull();
  });

  it('lands invoices net of tax and credit memos as negative', async () => {
    const rows = await harness.db.select().from(t.factInvoice);
    const byKey = new Map(rows.map((r) => [r.invoiceKey, r]));
    expect(Number(byKey.get('INV:3')!.billed)).toBe(10000);
    expect(Number(byKey.get('CM:7')!.billed)).toBe(-2000);
  });

  it('normalises names the way a person would compare them', () => {
    expect(normaliseName('The Acme Company, LLC')).toBe('acme');
    expect(normaliseName('Beta Health LLC')).toBe(normaliseName('Beta Health'));
    expect(normaliseName('New York Life')).toBe('new york life');
  });
});

describe('account billing', () => {
  it('matches by domain first, then by the same name, and only suggests the rest', async () => {
    const model = await billing();
    expect(row(model.rows, 'Acme').match).toMatchObject({ method: 'DOMAIN', customerId: 'C1' });
    expect(row(model.rows, 'Beta').match).toMatchObject({ method: 'NAME', customerId: 'C2' });
    const gamma = row(model.rows, 'Gamma');
    expect(gamma.match.customerId).toBeNull();
    expect(gamma.match.suggestions.map((s) => s.id)).toContain('C3');
    expect(row(model.rows, 'Delta').status).toBe('NO_MATCH');
  });

  it('counts a customer’s sub-customers and credit memos, from the day it was won', async () => {
    const acme = row((await billing()).rows, 'Acme');
    // 10,000 + 10,000 (job, tax excluded) − 2,000 credit; the March invoice predates the win.
    expect(acme.billedSinceWon).toBe(18000);
    expect(acme.billedBeforeWon).toBe(5000);
    expect(acme.invoiceCount).toBe(3);
  });

  it('measures pace against a straight-line twelve months from going live', async () => {
    const model = await billing();
    const acme = row(model.rows, 'Acme');
    // Three months live of a $120,000 year: about $30,000 expected, $18,000 billed.
    expect(Math.round(acme.expectedToDate / 1000)).toBe(30);
    expect(acme.status).toBe('BEHIND');
    expect(row(model.rows, 'Beta').status).toBe('AHEAD');
    expect(row(model.rows, 'Omega').status).toBe('NOT_BILLING');
  });

  it('lists the accounts that need attention under their owner', async () => {
    const model = await billing();
    const mario = model.alerts.find((group) => group.owner === 'Mario Pecoraro');
    expect(mario?.rows.map((r) => r.account).sort()).toEqual(['Acme Logistics, Inc.', 'Omega Systems']);
  });

  it('lets a decision in Admin override the suggestion, either way', async () => {
    await decideAccountMatch(harness.db, user.id, { companyId: 'co3', customerId: 'C3' });
    await decideAccountMatch(harness.db, user.id, { companyId: 'co2', customerId: null });
    const model = await billing();
    expect(row(model.rows, 'Gamma').match.method).toBe('CONFIRMED');
    expect(row(model.rows, 'Gamma').status).toBe('NOT_BILLING');
    expect(row(model.rows, 'Beta').match.method).toBe('REJECTED');
    expect(row(model.rows, 'Beta').status).toBe('NO_MATCH');

    await decideAccountMatch(harness.db, user.id, { companyId: 'co2', customerId: 'auto' });
    expect(row((await billing()).rows, 'Beta').match.method).toBe('NAME');
    await expect(
      decideAccountMatch(harness.db, user.id, { companyId: 'co4', customerId: 'NOPE' }),
    ).rejects.toThrow(/not in the customer list/);
  });

  it('answers the assistant from the same figures', async () => {
    const { toolByName } = await import('@/lib/ai/tools');
    const session = await openSemanticSession(harness.db, user, '2026-10-01');
    const outcome = await toolByName('get_account_billing')!.run(
      { wonFrom: '2026-06', wonTo: '2026-10', account: 'Acme' },
      { db: harness.db, user, session, conversationId: null },
    );
    const result = outcome.result as { rows: Array<{ billedSinceWon: string; matchedBy: string }> };
    expect(result.rows[0]!.billedSinceWon).toBe('$18,000');
    expect(result.rows[0]!.matchedBy).toMatch(/domain/);
  });
});

describe('figures the assistant states', () => {
  const evidence = [JSON.stringify({ deals: 7, total: '$131,200', receivables: 786338.12 })];

  it('finds dollar amounts and counts of things the reader acts on', () => {
    const found = statedFigures('Seven deals, $131,200 in total, and 32 other won deals worth $1,027,400.');
    expect(found.map((f) => f.text)).toEqual(['$131,200', '$1,027,400', '32 other won deals']);
  });

  it('flags a figure no tool returned — the November cases', () => {
    const bad = unsupportedFigures(
      'There are 32 other won deals worth $1,027,400 beyond these seven.',
      evidence,
    );
    expect(bad.map((f) => f.text)).toEqual(['$1,027,400', '32 other won deals']);
  });

  it('accepts figures a tool returned, including a stated rounding', () => {
    expect(unsupportedFigures('The seven deals total $131,200; receivables are $786,338 (about $786K).', evidence)).toEqual([]);
  });
});

describe('an answer with an unsourced figure', () => {
  it('is withdrawn and rewritten before it is final', async () => {
    const turns = [
      // First answer: a figure from nowhere.
      { text: 'ARG-wide receivables are $786,338.', toolCalls: [] },
      // The rewrite, after being sent back.
      { text: 'Receivables by customer are not available from the tools I have.', toolCalls: [] },
    ];
    const seen: string[] = [];
    vi.doMock('@/lib/ai/provider', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
      isModelConfigured: () => true,
      activeModel: () => 'test-model',
      streamTurn: async ({ onText, messages }: { onText: (d: string) => void; messages: Array<{ role: string; content?: string }> }) => {
        const next = turns.shift()!;
        seen.push(messages[messages.length - 1]?.content ?? '');
        onText(next.text);
        return next;
      },
    }));
    vi.resetModules();
    const { runAgentTurn } = await import('@/lib/ai/agent');
    const session = await openSemanticSession(harness.db, user, '2026-10-01');
    const events: string[] = [];
    const result = await runAgentTurn({
      user,
      session,
      pageContext: { page: 'HubSpot Leadership' },
      messages: [{ role: 'user', content: 'What are total receivables?' }],
      conversationId: null,
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toContain('reset');
    expect(seen[1]).toMatch(/\$786,338/);
    expect(result.content).toBe('Receivables by customer are not available from the tools I have.');
    vi.doUnmock('@/lib/ai/provider');
  });
});
