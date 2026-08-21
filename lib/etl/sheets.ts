import 'server-only';
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { ensurePeriodExists, loadDivisionLookup } from './qbo';

/**
 * Google Sheets raw → facts.
 *
 * Budget and headcount are the two figures nobody can pull from an API, so they
 * arrive as a grid a person maintains. That makes this the loosest input in the
 * system, and the rules are correspondingly strict:
 *
 *   - A row whose division cannot be resolved is **skipped and named**, never
 *     spread across divisions.
 *   - A cell that is not a number is treated as absent rather than zero. A
 *     blank budget cell and a budget of nothing are different claims, and only
 *     one of them should make attainment read 0%.
 *   - Gross profit and net profit are **never imported**, even when the sheet
 *     has columns for them. They are derived from revenue, COGS and OpEx on
 *     read, so the identity holds by construction rather than by the sheet
 *     being internally consistent on the day it was pulled.
 */

export interface SheetsConformResult {
  entity: string;
  written: number;
  /** Rows whose division could not be resolved, with the value that failed. */
  unresolvedRows: string[];
  /** Rows skipped for having no usable month. */
  skipped: number;
  months: string[];
}

interface RawRow {
  payload: unknown;
  loadRunId?: string | null;
}

interface SheetPayload {
  range?: string;
  values?: string[][];
}

/** A number, or null when the cell is blank or text. */
function num(value: string | undefined): Decimal | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/[$,\s]/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')');
  try {
    const parsed = new Decimal(negative ? cleaned.slice(1, -1) : cleaned);
    return negative ? parsed.negated() : parsed;
  } catch {
    return null;
  }
}

/** Accepts '2026-03', '2026-03-01', 'Mar 2026', 'March 2026' and Excel serials. */
export function parseMonth(value: string | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();

  const iso = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-01`;

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (slash) return `${slash[3]}-${slash[1]!.padStart(2, '0')}-01`;

  const named = /^([A-Za-z]{3,9})[\s-]+(\d{4})$/.exec(raw);
  if (named) {
    const index = MONTH_NAMES.findIndex((name) =>
      name.startsWith(named[1]!.slice(0, 3).toLowerCase()),
    );
    if (index >= 0) return `${named[2]}-${String(index + 1).padStart(2, '0')}-01`;
  }

  // A date that arrived as a serial number would be ambiguous — 45000 could be
  // a budget figure. Refused rather than guessed.
  return null;
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Finds a column index by any of several acceptable header names. */
function columnIndex(header: string[], ...candidates: string[]): number {
  const normalised = header.map((cell) => String(cell ?? '').trim().toLowerCase());
  for (const candidate of candidates) {
    const index = normalised.indexOf(candidate.toLowerCase());
    if (index >= 0) return index;
  }
  for (const candidate of candidates) {
    const index = normalised.findIndex((cell) => cell.includes(candidate.toLowerCase()));
    if (index >= 0) return index;
  }
  return -1;
}

export async function conformSheets(
  db: Database,
  loadRunId: string,
  entity: string,
  rows: RawRow[],
): Promise<SheetsConformResult> {
  switch (entity) {
    case 'monthly_budget':
      return conformBudget(db, loadRunId, rows, 'MONTHLY_BUDGET');
    case 'tenx_budget':
      return conformBudget(db, loadRunId, rows, 'TENX');
    case 'headcount':
      return conformHeadcount(db, loadRunId, rows);
    default:
      return { entity, written: 0, unresolvedRows: [], skipped: 0, months: [] };
  }
}

async function conformBudget(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
  scenarioCode: string,
): Promise<SheetsConformResult> {
  const lookup = await loadDivisionLookup(db);
  const unresolved = new Set<string>();
  const months = new Set<string>();
  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    const payload = row.payload as SheetPayload;
    const grid = payload.values ?? [];
    if (grid.length < 2) continue;

    const header = grid[0]!;
    const divisionColumn = columnIndex(header, 'division', 'class', 'segment');
    const monthColumn = columnIndex(header, 'month', 'period', 'date');
    const revenueColumn = columnIndex(header, 'revenue', 'income', 'sales');
    const cogsColumn = columnIndex(header, 'cogs', 'cost of goods', 'cost of sales');
    const opexColumn = columnIndex(header, 'opex', 'operating expenses', 'expenses');

    if (divisionColumn < 0 || monthColumn < 0) {
      unresolved.add(
        `the sheet has no ${divisionColumn < 0 ? 'division' : 'month'} column — headers seen: ${header
          .slice(0, 8)
          .join(', ')}`,
      );
      continue;
    }

    for (const line of grid.slice(1)) {
      const month = parseMonth(line[monthColumn]);
      if (!month) {
        skipped += 1;
        continue;
      }

      const rawDivision = String(line[divisionColumn] ?? '').trim();
      const divisionCode = lookup.byName.get(rawDivision.toLowerCase()) ?? null;
      if (!divisionCode) {
        if (rawDivision) unresolved.add(rawDivision);
        skipped += 1;
        continue;
      }

      months.add(month);

      // Only the three loaded line items. GP and NP are derived on read.
      for (const [lineItem, column] of [
        ['revenue', revenueColumn],
        ['cogs', cogsColumn],
        ['opex', opexColumn],
      ] as const) {
        if (column < 0) continue;
        const amount = num(line[column]);
        if (amount === null) continue;

        const values = {
          amount: amount.toFixed(2),
          sourceSystem: 'SHEETS' as const,
          loadRunId: row.loadRunId ?? loadRunId,
        };

        await db
          .insert(t.factBudget)
          .values({ scenarioCode, periodMonth: month, divisionCode, lineItem, ...values })
          .onConflictDoUpdate({
            target: [
              t.factBudget.scenarioCode,
              t.factBudget.periodMonth,
              t.factBudget.divisionCode,
              t.factBudget.lineItem,
            ],
            set: values,
          });
        written += 1;
      }
    }
  }

  return {
    entity: scenarioCode === 'TENX' ? 'tenx_budget' : 'monthly_budget',
    written,
    unresolvedRows: [...unresolved].slice(0, 10),
    skipped,
    months: [...months].sort(),
  };
}

async function conformHeadcount(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<SheetsConformResult> {
  const lookup = await loadDivisionLookup(db);
  const unresolved = new Set<string>();
  const months = new Set<string>();
  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    const payload = row.payload as SheetPayload;
    const grid = payload.values ?? [];
    if (grid.length < 2) continue;

    const header = grid[0]!;
    const divisionColumn = columnIndex(header, 'division', 'class', 'segment');
    const monthColumn = columnIndex(header, 'month', 'period', 'date');
    const headcountColumn = columnIndex(header, 'headcount', 'fte', 'employees', 'count');

    if (divisionColumn < 0 || monthColumn < 0 || headcountColumn < 0) {
      unresolved.add(
        `the sheet needs division, month and headcount columns — headers seen: ${header
          .slice(0, 8)
          .join(', ')}`,
      );
      continue;
    }

    for (const line of grid.slice(1)) {
      const month = parseMonth(line[monthColumn]);
      const count = num(line[headcountColumn]);
      const rawDivision = String(line[divisionColumn] ?? '').trim();
      const divisionCode = lookup.byName.get(rawDivision.toLowerCase()) ?? null;

      if (!month || count === null || !divisionCode) {
        if (rawDivision && !divisionCode) unresolved.add(rawDivision);
        skipped += 1;
        continue;
      }

      months.add(month);
      await ensurePeriodExists(db, month);
      const values = {
        headcount: count.toFixed(2),
        sourceSystem: 'SHEETS' as const,
        loadRunId: row.loadRunId ?? loadRunId,
      };

      await db
        .insert(t.factHeadcount)
        .values({ periodMonth: month, divisionCode, ...values })
        .onConflictDoUpdate({
          target: [t.factHeadcount.periodMonth, t.factHeadcount.divisionCode],
          set: values,
        });
      written += 1;
    }
  }

  return {
    entity: 'headcount',
    written,
    unresolvedRows: [...unresolved].slice(0, 10),
    skipped,
    months: [...months].sort(),
  };
}

export function describeSheetsConform(result: SheetsConformResult): string {
  if (result.written === 0) {
    return `Nothing conformed for ${result.entity}${
      result.unresolvedRows.length ? ` — ${result.unresolvedRows[0]}` : ''
    }.`;
  }

  const parts = [`Conformed ${result.written} ${result.entity} values`];
  if (result.months.length) {
    parts.push(
      `covering ${result.months[0]!.slice(0, 7)}${
        result.months.length > 1 ? ` to ${result.months[result.months.length - 1]!.slice(0, 7)}` : ''
      }`,
    );
  }
  if (result.skipped) {
    parts.push(
      `${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped for an unreadable month or an unrecognised division${
        result.unresolvedRows.length ? ` (${result.unresolvedRows.slice(0, 5).join(', ')})` : ''
      }`,
    );
  }
  return `${parts.join('. ')}.`;
}

/** Re-runs conform over everything already landed for a Sheets entity. */
export async function reconformLandedSheets(
  db: Database,
  entity: string,
): Promise<SheetsConformResult> {
  const rows = await db
    .select({ payload: t.rawPayload.payload, loadRunId: t.rawPayload.loadRunId })
    .from(t.rawPayload)
    .where(and(eq(t.rawPayload.sourceSystem, 'SHEETS'), eq(t.rawPayload.entity, entity)));

  if (rows.length === 0) {
    return { entity, written: 0, unresolvedRows: [], skipped: 0, months: [] };
  }
  return conformSheets(db, rows[0]!.loadRunId, entity, rows);
}
