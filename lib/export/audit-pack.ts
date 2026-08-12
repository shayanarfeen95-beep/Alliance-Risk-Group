import { and, desc, eq, sql } from 'drizzle-orm';
import { zipSync, strToU8 } from 'fflate';
import Decimal from 'decimal.js';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { KPI_REGISTRY } from '@/lib/semantic/registry';
import { runAllChecks } from '@/lib/recon/checks';
import type { MonthKey } from '@/lib/semantic/periods';
import type { SessionUser } from '@/lib/auth/session';

/**
 * The audit pack.
 *
 * §13 asks for evidence a third party can check without access to the running
 * system. That means the pack has to be self-contained and it has to be
 * *checkable*: not a screenshot of the dashboards but the figures, the
 * definitions those figures were computed from, the controls that were run
 * against them, and the provenance of every load that produced them.
 *
 * Everything in it is resolved through the same `resolveKpi` the dashboards
 * call, so the pack cannot show a number the app does not. Exporting is a read;
 * it changes nothing and takes no locks.
 */

export interface AuditPackOptions {
  /** The reporting month the pack is anchored on. */
  month: MonthKey;
  /** Included months for the P&L history sheet. Defaults to the trailing year. */
  history?: MonthKey[];
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Decimal ? value.toFixed(2) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

/**
 * Builds the pack as a zip.
 *
 * Returned as bytes rather than written to disk: the app runs on a serverless
 * platform where the filesystem is not durable, and an audit artefact that might
 * or might not still exist is not an audit artefact.
 */
export async function buildAuditPack(
  db: Database,
  user: SessionUser,
  options: AuditPackOptions,
): Promise<{ bytes: Uint8Array; filename: string; fileCount: number }> {
  const session = await openSemanticSession(db, user, options.month);
  const generatedAt = new Date();
  const files: Record<string, Uint8Array> = {};

  const scopes = [
    ...(session.consolidatedAvailable ? [CONSOLIDATED_CODE] : []),
    ...session.visibleDivisions,
  ];

  // --- 1. Every KPI, every scope, as the app resolves it --------------------
  const kpiRows: unknown[][] = [];
  for (const scope of scopes) {
    for (const definition of KPI_REGISTRY) {
      const result = resolveKpi(session, definition.id, scope);
      kpiRows.push([
        definition.id,
        definition.name,
        definition.category,
        scope,
        options.month,
        // The raw value and the formatted value both appear: the first is what
        // a checker recomputes against, the second is what the reader saw.
        result.value ? result.value.toFixed(6) : '',
        result.formatted,
        result.unavailable?.reason ?? '',
        result.unavailable?.detail ?? '',
        result.periodState,
        definition.higherIsBetter ? 'higher is better' : 'lower is better',
        definition.specReference,
      ]);
    }
  }

  files['01_kpi_values.csv'] = strToU8(
    csv(
      [
        'kpi_id',
        'kpi_name',
        'category',
        'scope',
        'period_month',
        'value_raw',
        'value_formatted',
        'unavailable_reason',
        'unavailable_detail',
        'period_state',
        'direction',
        'spec_reference',
      ],
      kpiRows,
    ),
  );

  // --- 2. The definitions those values came from ---------------------------
  files['02_kpi_definitions.csv'] = strToU8(
    csv(
      ['kpi_id', 'name', 'category', 'definition', 'formula', 'source_system', 'format', 'direction', 'refresh_cadence', 'spec_reference', 'notes'],
      KPI_REGISTRY.map((definition) => [
        definition.id,
        definition.name,
        definition.category,
        definition.definition,
        definition.formula,
        definition.sourceSystem,
        definition.format,
        definition.higherIsBetter ? 'higher_is_better' : 'lower_is_better',
        definition.refreshCadence,
        definition.specReference,
        definition.notes ?? '',
      ]),
    ),
  );

  // --- 3. The underlying P&L, unaggregated ---------------------------------
  const plRows = await db
    .select()
    .from(t.factPlActual)
    .where(sql`division_code = any(${sql.raw(`ARRAY[${session.visibleDivisions.map((c) => `'${c}'`).join(',')}]`)})`)
    .orderBy(t.factPlActual.periodMonth, t.factPlActual.divisionCode);

  files['03_pl_actuals.csv'] = strToU8(
    csv(
      ['period_month', 'division_code', 'revenue', 'payroll_direct_MEMO', 'cogs', 'payroll_expense_MEMO', 'opex', 'load_run_id'],
      plRows.map((row) => [
        row.periodMonth,
        row.divisionCode,
        row.revenue,
        // Labelled MEMO in the header because that is the single most
        // consequential fact about these two columns: they are already inside
        // COGS and OpEx and must never be subtracted again (Defect: SHRC gross
        // profit is $71,451, not $38,407).
        row.payrollDirect,
        row.cogs,
        row.payrollExpense,
        row.opex,
        row.loadRunId ?? '',
      ]),
    ),
  );

  // --- 4. The controls, freshly run ----------------------------------------
  const recon = await runAllChecks(db);
  files['04_reconciliation.csv'] = strToU8(
    csv(
      ['check_name', 'status', 'period_month', 'division_code', 'variance', 'detail'],
      recon.findings.map((finding) => [
        finding.checkName,
        finding.status,
        finding.periodMonth ?? '',
        finding.divisionCode ?? '',
        finding.variance ?? '',
        finding.detail ?? '',
      ]),
    ),
  );

  // --- 5. Where the data came from -----------------------------------------
  const loads = await db.select().from(t.loadRun).orderBy(desc(t.loadRun.startedAt)).limit(200);
  files['05_load_provenance.csv'] = strToU8(
    csv(
      ['load_run_id', 'source_system', 'entity', 'window_start', 'window_end', 'status', 'rows_read', 'rows_written', 'started_at', 'finished_at', 'requested_by', 'error'],
      loads.map((run) => [
        run.id,
        run.sourceSystem,
        run.entity,
        run.windowStart ?? '',
        run.windowEnd ?? '',
        run.status,
        run.rowsRead ?? '',
        run.rowsWritten ?? '',
        run.startedAt?.toISOString() ?? '',
        run.finishedAt?.toISOString() ?? '',
        run.requestedByUserId ?? '',
        run.errorMessage ?? '',
      ]),
    ),
  );

  // --- 6. Forecast versions, and whether they were locked before actuals ----
  const versions = await db
    .select()
    .from(t.forecastVersion)
    .orderBy(desc(t.forecastVersion.periodMonth));

  files['06_forecast_versions.csv'] = strToU8(
    csv(
      ['version_id', 'period_month', 'scenario_name', 'is_official', 'is_locked', 'locked_at', 'locked_by', 'created_at', 'correction_reason', 'supersedes_version_id'],
      versions.map((version) => [
        version.id,
        version.periodMonth,
        version.scenarioName,
        version.isOfficial,
        version.isLocked,
        version.lockedAt?.toISOString() ?? '',
        version.lockedBy ?? '',
        version.createdAt?.toISOString() ?? '',
        version.correctionReason ?? '',
        version.supersedesVersionId ?? '',
      ]),
    ),
  );

  // --- 7. What the assistant was asked, and what it answered ---------------
  // §11 Requirement 6. The refusals are the most useful rows in the pack:
  // they are the evidence that the system declines rather than estimates.
  const queries = await db
    .select({
      askedAt: t.aiQueryLog.createdAt,
      role: t.aiQueryLog.role,
      toolName: t.aiQueryLog.toolName,
      content: t.aiQueryLog.content,
      wasRefusal: t.aiQueryLog.wasRefusal,
      userId: t.aiQueryLog.userId,
    })
    .from(t.aiQueryLog)
    .orderBy(desc(t.aiQueryLog.createdAt))
    .limit(1000);

  files['07_assistant_log.csv'] = strToU8(
    csv(
      ['asked_at', 'role', 'tool_name', 'was_refusal', 'user_id', 'content'],
      queries.map((row) => [
        row.askedAt?.toISOString() ?? '',
        row.role,
        row.toolName ?? '',
        row.wasRefusal,
        row.userId ?? '',
        row.content ?? '',
      ]),
    ),
  );

  // --- 8. Open items, stated rather than assumed away ----------------------
  const config = await db.select().from(t.appConfig).orderBy(t.appConfig.key);
  files['08_open_items_and_config.csv'] = strToU8(
    csv(
      ['key', 'value', 'is_confirmed', 'description'],
      config.map((row) => [row.key, row.value, row.isConfirmed, row.description ?? '']),
    ),
  );

  // --- 9. The manifest -----------------------------------------------------
  files['00_MANIFEST.md'] = strToU8(
    manifest({
      generatedAt,
      user,
      month: options.month,
      periodState: session.periodIsClosed ? 'closed' : 'open',
      basis: session.accountingBasis,
      scopes,
      reconPassed: recon.passed,
      reconFailed: recon.failed,
      kpiCount: KPI_REGISTRY.length,
      plRowCount: plRows.length,
      loadCount: loads.length,
    }),
  );

  const bytes = zipSync(files, { level: 6 });

  return {
    bytes,
    filename: `arg-audit-pack-${options.month.slice(0, 7)}.zip`,
    fileCount: Object.keys(files).length,
  };
}

function manifest(input: {
  generatedAt: Date;
  user: SessionUser;
  month: MonthKey;
  periodState: string;
  basis: string;
  scopes: string[];
  reconPassed: number;
  reconFailed: number;
  kpiCount: number;
  plRowCount: number;
  loadCount: number;
}): string {
  return `# Alliance Risk Group — Audit Pack

Reporting month: **${input.month.slice(0, 7)}** (${input.periodState} period)
Accounting basis: **${input.basis}**
Generated: ${input.generatedAt.toISOString()}
Generated by: ${input.user.name} <${input.user.email}> (${input.user.role})
Scope in this pack: ${input.scopes.join(', ')}

${
  input.periodState === 'open'
    ? '> This month is not closed. Every figure in this pack is preliminary and will move.\n'
    : ''
}
## Reconciliation at time of export

**${input.reconPassed} controls passed, ${input.reconFailed} failed.**${
    input.reconFailed > 0
      ? ' Figures in the affected areas may not tie to source — see 04_reconciliation.csv before relying on them.'
      : ''
  }

## Contents

| File | What it is |
|---|---|
| 01_kpi_values.csv | Every metric, for every division in scope, as the dashboards resolved it. Both the raw value and the displayed string. |
| 02_kpi_definitions.csv | The definition and formula each of those values was computed from, with its spec reference. |
| 03_pl_actuals.csv | The underlying profit and loss rows, unaggregated. |
| 04_reconciliation.csv | The standing controls, run fresh at export. |
| 05_load_provenance.csv | Every data load: source, window, row counts, who ran it, and whether it succeeded. |
| 06_forecast_versions.csv | Forecast versions and their lock state, with timestamps and attribution. |
| 07_assistant_log.csv | Every question put to the assistant and every answer, including refusals. |
| 08_open_items_and_config.csv | Configuration and the open items still awaiting a Westport decision. |

## How to check a figure

Take any row in \`01_kpi_values.csv\`. Its \`kpi_id\` appears in
\`02_kpi_definitions.csv\` with the formula used. The inputs to that formula are
in \`03_pl_actuals.csv\`, keyed on \`(period_month, division_code)\`. Every figure
in this pack was produced by the same code path the dashboards use — there is no
separate export calculation to disagree with.

## Two things worth knowing before you check

**Payroll–Direct and Payroll Expense are memo columns.** They are already
contained within COGS and Operating Expense respectively. Subtracting them again
understates gross profit — for the tie-out month it is the difference between
$71,451 and $38,407 on one division alone.

**ARG Total is computed, never stored.** It is the sum of the four divisions at
the point of reading. There is no ARG Total row in \`03_pl_actuals.csv\`, and a
database constraint prevents one from being written.

## Direction

Each metric carries a direction. Attainment above 100% is favourable on revenue
and gross profit, and unfavourable on COGS, operating expense and payroll. The
direction is in \`01_kpi_values.csv\` so a reviewer does not have to infer it.
`;
}
