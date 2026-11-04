/**
 * What the QuickBooks connector asks for when it reads billing.
 *
 * Only the columns the comparison needs (a full invoice carries every line),
 * everything from January of last year the first time, only what changed after
 * that, and a page boundary it can resume from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: string[] = [];
let pages: Record<string, number[]> = {};

vi.mock('@/lib/connectors/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/credentials')>()),
  isConnected: async () => true,
  loadCredential: async () => ({ authMethod: 'COMPOSIO', data: { connectedAccountId: 'ca_test', realmId: '123' } }),
}));

vi.mock('@/lib/connectors/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/composio')>()),
  proxy: async ({ query }: { query: { query: string } }) => {
    queries.push(query.query);
    const kind = query.query.includes('from CreditMemo') ? 'CreditMemo' : 'Invoice';
    const size = pages[kind]?.shift() ?? 0;
    return {
      QueryResponse: {
        [kind]: Array.from({ length: size }, (_, index) => ({
          Id: `${kind}-${index}`,
          MetaData: { LastUpdatedTime: '2026-10-30T10:00:00Z' },
        })),
      },
    };
  },
}));

const { qboConnector } = await import('@/lib/connectors/qbo');
const window = { start: '2026-10-01', end: '2026-10-01' };

beforeEach(() => {
  queries.length = 0;
  pages = {};
});

describe('reading billing from QuickBooks', () => {
  it('asks for the needed columns from January of last year, then credit memos', async () => {
    pages = { Invoice: [3], CreditMemo: [1] };
    const batch = await qboConnector.fetch('invoices', window);
    expect(queries[0]).toMatch(/^select Id, DocNumber, TxnDate, CustomerRef, TotalAmt, Balance, TxnTaxDetail, MetaData from Invoice/);
    expect(queries[0]).toContain(`TxnDate >= '${new Date().getUTCFullYear() - 1}-01-01'`);
    expect(queries[1]).toContain('from CreditMemo');
    expect(batch.nextCursor).toBeNull();
    expect(batch.watermark?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('reads only what changed once there is a watermark', async () => {
    pages = { Invoice: [0], CreditMemo: [0] };
    await qboConnector.fetch('invoices', window, { since: new Date('2026-10-29T00:00:00Z') });
    expect(queries[0]).toContain("MetaData.LastUpdatedTime >= '2026-10-29T00:00:00Z'");
  });

  it('stops on a page boundary and resumes from it', async () => {
    pages = { Invoice: [1000, 2], CreditMemo: [0] };
    const first = await qboConnector.fetch('invoices', window, { maxRecords: 500 });
    expect(first.nextCursor).toBe(JSON.stringify({ kind: 0, start: 1001 }));
    await qboConnector.fetch('invoices', window, { cursor: first.nextCursor });
    expect(queries[1]).toContain('startposition 1001');
  });
});
