/**
 * Reading a QuickBooks report.
 *
 * QBO's report API does not return a table. It returns a tree of sections whose
 * leaves are the account rows and whose branches carry their own summary rows,
 * and both look similar enough that a naive walker adds every figure twice —
 * once as a leaf, once inside its section total. Everything here exists to walk
 * that tree exactly once.
 *
 * Two decisions worth stating, because both are places where a plausible
 * shortcut silently produces wrong numbers:
 *
 *   1. **Summary rows are never read.** Only `type: "Data"` rows contribute.
 *      A section total is the sum of rows we already have.
 *   2. **The TOTAL column is dropped.** It is QBO's own consolidation, and §3
 *      says ARG Total is a rollup and never a row. Reading it would store a
 *      figure that could later disagree with the sum of the divisions — which
 *      is precisely the drift the whole design exists to prevent.
 *
 * Pure functions, no database. The mapping from class to division and account
 * to reporting line happens in `conform.ts`, against the dimension tables.
 */

export interface QboColumn {
  index: number;
  title: string;
  /** Present only on a column QBO produced by summarising on Classes. */
  classId: string | null;
}

export interface QboAccountRow {
  accountId: string | null;
  accountName: string;
  /** Column index -> amount as it appeared, unparsed. */
  amounts: Map<number, string>;
  /** The section path this row sat under: ["Expenses", "Payroll"]. */
  section: string[];
  /** The `group` of the nearest enclosing section, when QBO supplied one. */
  group: string | null;
}

export interface QboReport {
  reportName: string;
  startPeriod: string | null;
  endPeriod: string | null;
  currency: string | null;
  columns: QboColumn[];
  /** Columns that carry a class, i.e. the ones that resolve to a division. */
  classColumns: QboColumn[];
  rows: QboAccountRow[];
}

interface RawColData {
  value?: string;
  id?: string;
}

interface RawRow {
  type?: string;
  group?: string;
  ColData?: RawColData[];
  Header?: { ColData?: RawColData[] };
  Rows?: { Row?: RawRow[] };
  Summary?: { ColData?: RawColData[] };
}

interface RawReport {
  Header?: {
    ReportName?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
  };
  Columns?: {
    Column?: Array<{
      ColTitle?: string;
      ColType?: string;
      MetaData?: Array<{ Name?: string; Value?: string }>;
    }>;
  };
  Rows?: { Row?: RawRow[] };
}

export class QboReportShapeError extends Error {
  constructor(message: string) {
    super(
      `${message} This is a QuickBooks response this parser does not recognise; nothing was ` +
        'conformed. The raw payload is retained under its load run, so the load can be replayed ' +
        'once the parser is corrected without calling QuickBooks again.',
    );
    this.name = 'QboReportShapeError';
  }
}

/**
 * The class a column represents.
 *
 * QBO puts it in MetaData as `ClassRef`. When summarising by class it also
 * emits an unclassed column — headed "Not Specified" — for transactions with no
 * class on them. That column is real data about a real gap and must not be
 * quietly folded into a division, so it is returned like any other and
 * `conform.ts` refuses it by name.
 */
function classOf(column: { MetaData?: Array<{ Name?: string; Value?: string }> }): string | null {
  const entry = column.MetaData?.find((meta) => meta.Name === 'ClassRef');
  return entry?.Value ?? null;
}

const TOTAL_TITLES = new Set(['TOTAL', 'TOTAL ', 'Total']);

export function parseQboReport(payload: unknown): QboReport {
  const report = payload as RawReport;
  if (!report || typeof report !== 'object' || !report.Columns) {
    throw new QboReportShapeError('The response has no Columns block.');
  }

  const rawColumns = report.Columns.Column ?? [];
  const columns: QboColumn[] = rawColumns.map((column, index) => ({
    index,
    title: (column.ColTitle ?? '').trim(),
    classId: classOf(column),
  }));

  // QBO's own consolidation. Dropped on purpose — see the header comment.
  const classColumns = columns.filter(
    (column) => column.index > 0 && !TOTAL_TITLES.has(column.title.toUpperCase()),
  );

  const rows: QboAccountRow[] = [];
  walk(report.Rows?.Row ?? [], [], null, rows);

  return {
    reportName: report.Header?.ReportName ?? 'unknown',
    startPeriod: report.Header?.StartPeriod ?? null,
    endPeriod: report.Header?.EndPeriod ?? null,
    currency: report.Header?.Currency ?? null,
    columns,
    classColumns,
    rows,
  };
}

/**
 * Depth-first over the row tree, collecting leaves only.
 *
 * A row with nested `Rows` is a section: recurse, and ignore its `Summary`,
 * which restates what the children already said. A row with `ColData` and no
 * children is an account line, and is the only kind that produces a figure.
 */
function walk(
  rawRows: RawRow[],
  section: string[],
  group: string | null,
  out: QboAccountRow[],
): void {
  for (const row of rawRows) {
    const header = row.Header?.ColData?.[0]?.value?.trim();
    const nested = row.Rows?.Row;

    if (nested && nested.length > 0) {
      walk(nested, header ? [...section, header] : section, row.group ?? group, out);
      continue;
    }

    // A section can be empty and still carry a header; nothing to take from it.
    if (!row.ColData || row.ColData.length === 0) continue;

    // Section subtotals sometimes arrive as a sibling Data row titled "Total …".
    // Reading one would double the section. The account id is the discriminator:
    // a real account line carries one, a subtotal does not.
    const first = row.ColData[0];
    const name = (first?.value ?? '').trim();
    if (!first?.id && /^total\b/i.test(name)) continue;

    const amounts = new Map<number, string>();
    row.ColData.forEach((cell, index) => {
      if (index === 0) return;
      const value = (cell?.value ?? '').trim();
      if (value !== '') amounts.set(index, value);
    });

    out.push({
      accountId: first?.id ?? null,
      accountName: name,
      amounts,
      section,
      group: row.group ?? group,
    });
  }
}

/**
 * QBO money as a number.
 *
 * Blank means the account had no activity in that class, which is a zero and
 * not a missing value. Anything else that will not parse is an error rather
 * than a zero — a silent zero here understates a cost and nobody would see it.
 */
export function parseQboAmount(raw: string | undefined, context: string): number {
  if (raw === undefined || raw.trim() === '') return 0;

  const cleaned = raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    throw new QboReportShapeError(`Could not read "${raw}" as an amount (${context}).`);
  }
  return value;
}
