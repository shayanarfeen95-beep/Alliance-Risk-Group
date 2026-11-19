/**
 * Uploading the 2027 budget: CSV and Excel read into the budget reader's grid,
 * and an uploaded budget is the one its year is measured against.
 */
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readCsv, readSpreadsheet } from '@/lib/upload/spreadsheet';
import { preferredBudgetScenario } from '@/lib/semantic/registry';
import type { FactBundle } from '@/lib/semantic/facts';

describe('reading an uploaded plan', () => {
  it('reads CSV with quoted commas', () => {
    expect(readCsv('Year,Month,Division,Revenue\r\n2027,Jan,SHRC,"1,250"\r\n')).toEqual([
      ['Year', 'Month', 'Division', 'Revenue'],
      ['2027', 'Jan', 'SHRC', '1,250'],
    ]);
  });

  it('reads the first worksheet of an Excel file', () => {
    const xlsx = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Division</t></si><si><t>Revenue</t></si><si><r><t>SH</t></r><r><t>RC</t></r></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1500.5</v></c></row></sheetData></worksheet>',
      ),
    });
    expect(readSpreadsheet(xlsx, 'Budget 2027.xlsx')).toEqual([
      ['Division', '', 'Revenue'],
      ['SHRC', '', '1500.5'],
    ]);
  });

  it('measures a year against the budget uploaded for it', () => {
    const bundle = {
      budget: new Map([
        ['QBO_BUDGET|2026-01-01|SHRC|revenue', 1],
        ['UPLOAD_BUDGET|2027-01-01|SHRC|revenue', 1],
      ]),
      company: new Map(),
    } as unknown as FactBundle;
    expect(preferredBudgetScenario(bundle, 2027)).toBe('UPLOAD_BUDGET');
    expect(preferredBudgetScenario(bundle, 2026)).toBe('QBO_BUDGET');
  });
});

describe('loading an uploaded budget', () => {
  it('writes the template layout as the uploaded budget', async () => {
    const { createTestDb } = await import('./helpers/db');
    const { seedDatabase } = await import('@/lib/seed/load');
    const { loadUploadedPlan } = await import('@/lib/etl/conform');
    const schema = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const harness = await createTestDb();
    try {
      await seedDatabase(harness.db);
      const [division] = await harness.db.select().from(schema.dimDivision).limit(1);
      const [run] = await harness.db.select({ id: schema.loadRun.id }).from(schema.loadRun).limit(1);
      const grid = readCsv(
        `Year,Month,Division,Revenue,COGS,OpEx\n2027,Jan,${division!.divisionCode},100000,40000,30000\n2027,Feb,${division!.divisionCode},110000,42000,31000\n`,
      );
      const result = await loadUploadedPlan(harness.db, run!.id, 'budget', grid, 'test upload');
      expect(result.written).toBe(6);
      const rows = await harness.db
        .select()
        .from(schema.factBudget)
        .where(eq(schema.factBudget.scenarioCode, 'UPLOAD_BUDGET'));
      expect(rows).toHaveLength(6);
      expect(result.months).toEqual(['2027-01-01', '2027-02-01']);
    } finally {
      await harness.close();
    }
  }, 180_000);
});
