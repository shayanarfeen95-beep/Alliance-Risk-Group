/**
 * The audit pack.
 *
 * The pack's only real claim is that a third party can check a figure without
 * access to the running system. These tests hold it to that: the figures must
 * match what the dashboards resolve, the memo columns must be labelled, ARG
 * Total must be absent from the fact rows, and a division manager's pack must
 * not contain a division they cannot see.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { buildAuditPack } from '@/lib/export/audit-pack';
import { KPI_REGISTRY } from '@/lib/semantic/registry';
import { TIE_OUT_MONTH, MARCH_2026 } from '@/lib/seed/reference';

let harness: TestDb;
let CFO_USER: SessionUser;
let CLAIMS_MANAGER_USER: SessionUser;
let pack: Record<string, string>;

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split('\n');
  const headers = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    // Enough of a CSV reader for the quoting this exporter emits.
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        cells.push(cell);
        cell = '';
      } else {
        cell += char;
      }
    }
    cells.push(cell);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  CFO_USER = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  CLAIMS_MANAGER_USER = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');

  const built = await buildAuditPack(harness.db, CFO_USER, { month: TIE_OUT_MONTH });
  const unzipped = unzipSync(built.bytes);
  pack = Object.fromEntries(Object.entries(unzipped).map(([name, bytes]) => [name, strFromU8(bytes)]));
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('the pack is self-contained', () => {
  it('contains a manifest and eight data files', () => {
    expect(Object.keys(pack).sort()).toEqual([
      '00_MANIFEST.md',
      '01_kpi_values.csv',
      '02_kpi_definitions.csv',
      '03_pl_actuals.csv',
      '04_reconciliation.csv',
      '05_load_provenance.csv',
      '06_forecast_versions.csv',
      '07_assistant_log.csv',
      '08_open_items_and_config.csv',
    ]);
  });

  it('every value row can be traced to a definition row', () => {
    const values = parseCsv(pack['01_kpi_values.csv']!);
    const definitions = new Set(parseCsv(pack['02_kpi_definitions.csv']!).map((row) => row.kpi_id));
    expect(values.length).toBeGreaterThan(0);
    for (const row of values) {
      expect(definitions.has(row.kpi_id!), row.kpi_id).toBe(true);
    }
  });

  it('states the reconciliation position rather than leaving it to be inferred', () => {
    expect(pack['00_MANIFEST.md']).toMatch(/\d+ controls passed, \d+ failed/);
  });

  it('warns on the face of the manifest when the month is open', async () => {
    const openPack = await buildAuditPack(harness.db, CFO_USER, { month: '2026-04-01' });
    const manifest = strFromU8(unzipSync(openPack.bytes)['00_MANIFEST.md']!);
    expect(manifest).toMatch(/not closed/i);
    expect(manifest).toMatch(/preliminary/i);
  });
});

describe('the pack cannot disagree with the dashboards', () => {
  it('every exported figure equals what resolveKpi returns', async () => {
    const session = await openSemanticSession(harness.db, CFO_USER, TIE_OUT_MONTH);
    const rows = parseCsv(pack['01_kpi_values.csv']!);

    let checked = 0;
    for (const row of rows) {
      const resolved = resolveKpi(session, row.kpi_id!, row.scope!);
      expect(row.value_formatted, `${row.kpi_id} @ ${row.scope}`).toBe(resolved.formatted);
      if (resolved.value !== null) {
        expect(row.value_raw).toBe(resolved.value.toFixed(6));
        checked++;
      }
      // A metric with no value must export its reason, never a blank that reads
      // as zero to whoever opens the CSV.
      if (resolved.value === null) {
        expect(row.value_raw).toBe('');
        expect(row.unavailable_reason).not.toBe('');
        expect(row.unavailable_detail!.length).toBeGreaterThan(10);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('carries the published tie-out figure for the month', () => {
    const rows = parseCsv(pack['01_kpi_values.csv']!);
    const revenue = rows.find((row) => row.kpi_id === 'revenue' && row.scope === CONSOLIDATED_CODE);
    expect(Number(revenue!.value_raw)).toBeCloseTo(MARCH_2026.ARG_TOTAL!.revenue, 0);

    const shrcGrossProfit = rows.find(
      (row) => row.kpi_id === 'gross_profit' && row.scope === 'SHRC',
    );
    // The memo double-count would give $38,407 here.
    expect(Number(shrcGrossProfit!.value_raw)).toBeCloseTo(71_451, 0);
  });

  it('exports every metric in the registry, including the unavailable ones', () => {
    const rows = parseCsv(pack['01_kpi_values.csv']!);
    const exported = new Set(rows.filter((row) => row.scope === CONSOLIDATED_CODE).map((row) => row.kpi_id));
    for (const definition of KPI_REGISTRY) {
      expect(exported.has(definition.id), definition.id).toBe(true);
    }
  });
});

describe('the pack does not mislead a reader who opens it cold', () => {
  it('labels the memo columns in the header', () => {
    const header = pack['03_pl_actuals.csv']!.split('\n')[0]!;
    expect(header).toContain('payroll_direct_MEMO');
    expect(header).toContain('payroll_expense_MEMO');
  });

  it('explains the memo columns in the manifest, with the figure at stake', () => {
    expect(pack['00_MANIFEST.md']).toMatch(/memo/i);
    expect(pack['00_MANIFEST.md']).toContain('71,451');
    expect(pack['00_MANIFEST.md']).toContain('38,407');
  });

  it('contains no ARG Total row in the fact data', () => {
    const rows = parseCsv(pack['03_pl_actuals.csv']!);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.division_code).not.toBe('ARG_TOTAL');
    }
  });

  it('states the direction of every metric so it need not be inferred', () => {
    const rows = parseCsv(pack['01_kpi_values.csv']!);
    for (const row of rows) {
      expect(['higher is better', 'lower is better']).toContain(row.direction);
    }
  });

  it('carries the open items that are still awaiting a decision', () => {
    const rows = parseCsv(pack['08_open_items_and_config.csv']!);
    const unconfirmed = rows.filter((row) => row.is_confirmed === 'false');
    expect(unconfirmed.length).toBeGreaterThan(0);
    for (const row of unconfirmed) {
      expect(row.description!.length).toBeGreaterThan(20);
    }
  });
});

describe('the pack inherits the exporter’s entitlements', () => {
  it('a division manager’s pack contains only their division', async () => {
    const built = await buildAuditPack(harness.db, CLAIMS_MANAGER_USER, { month: TIE_OUT_MONTH });
    const files = unzipSync(built.bytes);

    const facts = parseCsv(strFromU8(files['03_pl_actuals.csv']!));
    expect(facts.length).toBeGreaterThan(0);
    for (const row of facts) {
      expect(row.division_code).toBe('CLAIMS');
    }

    const values = parseCsv(strFromU8(files['01_kpi_values.csv']!));
    for (const row of values) {
      expect(row.scope).toBe('CLAIMS');
    }

    // And the consolidated rollup is absent entirely — it would disclose the
    // other three divisions by subtraction.
    expect(values.some((row) => row.scope === CONSOLIDATED_CODE)).toBe(false);
  });
});
