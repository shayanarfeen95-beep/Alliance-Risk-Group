/**
 * Getting the provider's own payload out of Composio's envelope.
 *
 * Composio wraps a response in `data`, and depending on the tool the useful
 * object sits one level further down again. The conform layer parses
 * QuickBooks' native report tree, so what it needs is the object carrying
 * `Rows` and `Columns` — not whichever wrapper happens to be outermost.
 *
 * Unwrapping by assuming a depth is the obvious approach and the wrong one: a
 * change to Composio's envelope would then produce an empty report rather than
 * an error, and an empty P&L conforms to zero revenue without complaint.
 */
import { describe, expect, it } from 'vitest';
import { unwrapQboReport, unwrapHubspotList } from '@/lib/connectors/composio';

const report = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-03-01' },
  Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'SHRC' }] },
  Rows: { Row: [] },
};

describe('unwrapping a QuickBooks report', () => {
  it('finds the report however deeply Composio wrapped it', () => {
    expect(unwrapQboReport(report)).toBe(report);
    expect(unwrapQboReport({ data: report })).toBe(report);
    expect(unwrapQboReport({ data: { response_data: report } })).toBe(report);
    expect(unwrapQboReport({ data: { report } })).toBe(report);
  });

  it('throws with the keys it actually saw rather than returning nothing', () => {
    // The failure mode this prevents: returning `{}` here conforms as a P&L
    // with no rows, which is a division showing zero revenue for the month and
    // no error anywhere.
    let error: unknown;
    try {
      unwrapQboReport({ data: { unexpected_envelope: { totals: [] } } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Rows\/Columns/);
    expect((error as Error).message).toContain('unexpected_envelope');
    // And it points at the recovery: the payload is kept, so a replay is free.
    expect((error as Error).message).toMatch(/replayed/i);
  });

  it('does not chase a cycle forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.data = cyclic;
    expect(() => unwrapQboReport(cyclic)).toThrow(/Rows\/Columns/);
  });
});

describe('unwrapping a HubSpot list', () => {
  const page = {
    results: [{ id: '1' }, { id: '2' }],
    paging: { next: { after: 'cursor-2' } },
  };

  it('reads results and the pagination cursor, wrapped or not', () => {
    expect(unwrapHubspotList(page).results).toHaveLength(2);
    expect(unwrapHubspotList(page).after).toBe('cursor-2');

    expect(unwrapHubspotList({ data: page }).results).toHaveLength(2);
    expect(unwrapHubspotList({ data: page }).after).toBe('cursor-2');
  });

  it('returns an empty page rather than throwing on a last page', () => {
    // No `paging` means the walk is finished, which is normal and not an error.
    const last = unwrapHubspotList({ data: { results: [{ id: '9' }] } });
    expect(last.results).toHaveLength(1);
    expect(last.after).toBeUndefined();
  });

  it('treats an unrecognised shape as empty, which ends the walk', () => {
    expect(unwrapHubspotList({ nothing: true }).results).toEqual([]);
    expect(unwrapHubspotList(null).results).toEqual([]);
  });
});

describe('the Composio connectors name only read operations', () => {
  it('never references a HubSpot or QuickBooks write slug', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/connectors/composio.ts', 'utf8'),
    );

    // Rule 7 held the same way it is held everywhere else in this codebase:
    // by there being no code that could call it. HUBSPOT_UPDATE_DEALS is in
    // the same Composio toolkit and is one string away.
    for (const forbidden of [
      'HUBSPOT_UPDATE_DEALS',
      'HUBSPOT_CREATE_DEAL',
      'QUICKBOOKS_CREATE',
      'QUICKBOOKS_UPDATE',
      'QUICKBOOKS_DELETE',
    ]) {
      // The comment explaining the omission mentions one by name, so match on
      // it being used as a slug rather than merely appearing.
      expect(source).not.toContain(`'${forbidden}`);
      expect(source).not.toContain(`"${forbidden}`);
    }
  });
});
