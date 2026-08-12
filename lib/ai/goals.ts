import { and, eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import { d, formatValue } from '@/lib/money';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { getKpiDefinition } from '@/lib/semantic/registry';
import type { MonthKey } from '@/lib/semantic/periods';
import type { Citation } from '@/lib/semantic/types';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Standing goals: "watch this for me".
 *
 * The design decision that matters here is that goals evaluate in TypeScript,
 * not by handing an instruction string to a model on every overnight refresh.
 * A goal writes exceptions onto the CEO's dashboard, and an exception has to
 * fire for the same reason every time or nobody will trust the panel. So a goal
 * stores two things: the sentence its owner wrote, which is quoted back
 * verbatim, and a typed evaluator with validated parameters, which is what
 * actually runs.
 *
 * Every figure a finding quotes comes from `resolveKpi`. A goal cannot surface a
 * number the dashboards would disagree with, and a goal over a metric that is
 * unavailable produces no finding at all rather than a finding against zero —
 * "no data" is not "on target".
 */

export type Severity = 'good' | 'warning' | 'serious' | 'critical';

export interface Finding {
  goalId: string | null;
  goalName: string;
  periodMonth: MonthKey;
  divisionCode: string | null;
  severity: Severity;
  headline: string;
  detail: string;
  citations: Citation[];
}

export interface GoalRecord {
  id: string;
  name: string;
  instruction: string;
  evaluator: string;
  params: Record<string, unknown> | null;
  cadence: string;
  isActive: boolean;
}

interface EvaluatorContext {
  db: Database;
  session: SemanticSession;
  goal: GoalRecord;
}

interface Evaluator {
  id: string;
  label: string;
  /** Plain-language description, published in the admin goal builder. */
  description: string;
  /** Parameter names this evaluator reads, for the builder's form. */
  params: Array<{ name: string; label: string; required: boolean }>;
  run(context: EvaluatorContext): Promise<Finding[]> | Finding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityFor(gapRatio: Decimal): Severity {
  // How far past the threshold, as a fraction of the threshold. A metric that
  // misses by 1% and one that misses by 40% should not read the same on a panel
  // the CEO scans in ten seconds.
  const gap = gapRatio.abs();
  if (gap.greaterThanOrEqualTo(0.25)) return 'critical';
  if (gap.greaterThanOrEqualTo(0.1)) return 'serious';
  return 'warning';
}

/**
 * Formats an actual and its threshold so the breach is legible.
 *
 * At the display precision, a gross margin of 34.96% against a 35% threshold
 * renders as "35% against a threshold of 35%" — which reads as a contradiction
 * and costs the panel its credibility faster than a missing finding would. When
 * the two collide, both are re-rendered with enough decimals to separate them.
 */
function distinguish(
  actual: Decimal,
  threshold: Decimal,
  format: 'percent' | 'ratio' | 'currency' | 'days' | 'months' | 'count' | 'currency_precise',
): { actual: string; threshold: string } {
  const plain = { actual: formatValue(actual, format), threshold: formatValue(threshold, format) };
  if (plain.actual !== plain.threshold) return plain;

  const isRate = format === 'percent' || format === 'ratio';
  const scale = isRate ? 100 : 1;
  const suffix = isRate ? '%' : '';

  for (const decimals of [2, 3, 4]) {
    const a = actual.times(scale).toFixed(decimals);
    const th = threshold.times(scale).toFixed(decimals);
    if (a !== th) return { actual: `${a}${suffix}`, threshold: `${th}${suffix}` };
  }

  // Equal to four decimals is not a breach worth reporting as one.
  return plain;
}

/** The divisions a goal covers, defaulting to every division the user may see. */
function scopeOf(context: EvaluatorContext): string[] {
  const requested = context.goal.params?.divisions;
  if (Array.isArray(requested) && requested.length > 0) {
    return requested
      .map(String)
      .filter(
        (code) =>
          code === CONSOLIDATED_CODE
            ? context.session.consolidatedAvailable
            : context.session.visibleDivisions.includes(code),
      );
  }
  return context.session.visibleDivisions;
}

function numberParam(params: Record<string, unknown> | null, name: string): Decimal | null {
  const raw = params?.[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const value = d(raw as string | number);
  return value.isFinite() ? value : null;
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

/**
 * "Flag any division whose gross margin falls below 40%."
 *
 * Direction is read from the registry, never assumed: a threshold on OpEx fires
 * when the figure is *above* the line, and the same rule handles both because
 * `higherIsBetter` says which way is bad (§7).
 */
const kpiThreshold: Evaluator = {
  id: 'KPI_THRESHOLD',
  label: 'Metric crosses a threshold',
  description:
    'Fires when a metric moves past a fixed value in its unfavourable direction. The direction comes from the metric’s own definition, so a threshold on OpEx fires when spending is too high and one on gross margin fires when margin is too low.',
  params: [
    { name: 'kpi', label: 'Metric', required: true },
    { name: 'threshold', label: 'Threshold', required: true },
    { name: 'divisions', label: 'Divisions (blank = all)', required: false },
  ],
  run(context) {
    const kpiId = String(context.goal.params?.kpi ?? '');
    const definition = getKpiDefinition(kpiId);
    const threshold = numberParam(context.goal.params, 'threshold');
    if (!definition || !threshold) return [];

    const findings: Finding[] = [];

    for (const division of scopeOf(context)) {
      const result = resolveKpi(context.session, kpiId, division);

      // A metric that could not be produced is not a breach. Reporting "below
      // threshold" for a figure that does not exist is exactly the silent-zero
      // failure the whole build is written against.
      if (result.value === null) continue;

      const breached = definition.higherIsBetter
        ? result.value.lessThan(threshold)
        : result.value.greaterThan(threshold);
      if (!breached) continue;

      const gap = threshold.isZero()
        ? new Decimal(1)
        : result.value.minus(threshold).dividedBy(threshold.abs());

      findings.push({
        goalId: context.goal.id,
        goalName: context.goal.name,
        periodMonth: context.session.period.month,
        divisionCode: division === CONSOLIDATED_CODE ? null : division,
        severity: severityFor(gap),
        headline: `${definition.name} ${definition.higherIsBetter ? 'below' : 'above'} threshold — ${division === CONSOLIDATED_CODE ? 'ARG Total' : division}`,
        detail: (() => {
          const shown = distinguish(result.value, threshold, definition.format);
          return `${shown.actual} against a threshold of ${shown.threshold}. ${context.goal.instruction}`;
        })(),
        citations: result.citations,
      });
    }

    return findings;
  },
};

/**
 * "Tell me when a division misses its budget."
 *
 * Attainment and variance are kept in separate sentences on purpose. §7 is
 * explicit that a reader seeing "−36,773" beside "84%" reasonably assumes both
 * are variances, and this text is read fastest of anything in the app.
 */
const budgetAttainment: Evaluator = {
  id: 'BUDGET_ATTAINMENT',
  label: 'Budget attainment falls short',
  description:
    'Fires when actual performance against the monthly budget drops below a stated attainment percentage. Reports the attainment ratio and the dollar variance as two separate figures.',
  params: [
    { name: 'lineItem', label: 'Line item (revenue, cogs, opex)', required: true },
    { name: 'minAttainment', label: 'Minimum attainment (e.g. 0.9)', required: true },
    { name: 'scenario', label: 'Scenario (blank = monthly budget)', required: false },
    { name: 'divisions', label: 'Divisions (blank = all)', required: false },
  ],
  run(context) {
    const lineItem = String(context.goal.params?.lineItem ?? 'revenue');
    const scenario = String(context.goal.params?.scenario ?? 'MONTHLY_BUDGET');
    const floor = numberParam(context.goal.params, 'minAttainment') ?? d(0.9);

    // Direction comes from the line item, not from the attainment metric.
    // Attainment above 100% is good on revenue and bad on OpEx, and the
    // registry's note on `budget_attainment` says exactly that.
    const lineDefinition = getKpiDefinition(lineItem);
    if (!lineDefinition) return [];

    const findings: Finding[] = [];

    for (const division of scopeOf(context)) {
      const attainmentResult = resolveKpi(context.session, 'budget_attainment', division, {
        options: { lineItem, scenario },
      });

      const attainment = attainmentResult.value;
      const actual = attainmentResult.components?.actual;
      const budget = attainmentResult.components?.budget;
      const variance = attainmentResult.components?.varianceDollars;
      if (!attainment || !actual || !budget || !variance) continue;

      // A division that came in under its OpEx budget beat it. The symmetric
      // ceiling keeps one parameter meaningful in both directions.
      const missed = lineDefinition.higherIsBetter
        ? attainment.lessThan(floor)
        : attainment.greaterThan(new Decimal(2).minus(floor));
      if (!missed) continue;

      findings.push({
        goalId: context.goal.id,
        goalName: context.goal.name,
        periodMonth: context.session.period.month,
        divisionCode: division === CONSOLIDATED_CODE ? null : division,
        severity: severityFor(attainment.minus(1)),
        headline: `${lineDefinition.name} off budget — ${division === CONSOLIDATED_CODE ? 'ARG Total' : division}`,
        // Attainment and variance stay in separate sentences with their own
        // units. §7: a reader seeing "−36,773" beside "84%" reasonably assumes
        // both are variances.
        detail:
          `Attainment ${attainment.times(100).toFixed(0)}% of ${scenario === 'TENX' ? 'the 10X plan' : 'budget'}. ` +
          `Variance ${formatValue(variance, 'currency')} on ${formatValue(actual, 'currency')} actual against ${formatValue(budget, 'currency')} budgeted.`,
        citations: attainmentResult.citations,
      });
    }

    return findings;
  },
};

/**
 * "Tell me if the numbers stop tying to source."
 *
 * This is the goal Westport cares about most, because a failing control means
 * every other finding on the panel is suspect.
 */
const reconFailing: Evaluator = {
  id: 'RECON_FAILING',
  label: 'A reconciliation control is failing',
  description:
    'Fires when any standing reconciliation control fails on the latest run. A failing control means figures in the affected area may not tie to source.',
  params: [],
  async run(context) {
    const rows = await context.db
      .select({
        checkName: t.reconResult.checkName,
        detail: t.reconResult.detail,
        divisionCode: t.reconResult.divisionCode,
        periodMonth: t.reconResult.periodMonth,
      })
      .from(t.reconResult)
      .where(
        and(
          eq(t.reconResult.status, 'FAIL'),
          sql`ran_at = (select max(ran_at) from recon_result)`,
        ),
      );

    return rows.map((row) => ({
      goalId: context.goal.id,
      goalName: context.goal.name,
      periodMonth: (row.periodMonth ?? context.session.period.month) as MonthKey,
      divisionCode: row.divisionCode,
      severity: 'critical' as Severity,
      headline: `Reconciliation control failing: ${row.checkName}`,
      detail: `${row.detail ?? 'No detail recorded.'} Figures in this area may not tie to source — check before relying on them.`,
      citations: [],
    }));
  },
};

/**
 * "Do not let a month's actuals land before its forecast is locked."
 *
 * Defect 4 in preventative form: the value of a forecast-accuracy programme is
 * lost entirely if the forecast can be written after the fact.
 */
const forecastNotLocked: Evaluator = {
  id: 'FORECAST_NOT_LOCKED',
  label: 'Forecast not locked for an open month',
  description:
    'Fires when the current reporting month has no locked official forecast. Once actuals are entered, an unlocked forecast can no longer be scored honestly.',
  params: [],
  async run(context) {
    const month = context.session.period.month;

    const [official] = await context.db
      .select({ id: t.forecastVersion.id })
      .from(t.forecastVersion)
      .where(
        and(
          eq(t.forecastVersion.periodMonth, month),
          eq(t.forecastVersion.isOfficial, true),
          eq(t.forecastVersion.isLocked, true),
        ),
      )
      .limit(1);

    if (official) return [];

    return [
      {
        goalId: context.goal.id,
        goalName: context.goal.name,
        periodMonth: month,
        divisionCode: null,
        severity: context.session.periodIsClosed ? ('serious' as Severity) : ('warning' as Severity),
        headline: `No locked forecast for ${month.slice(0, 7)}`,
        detail: context.session.periodIsClosed
          ? 'This month is closed and no official forecast was ever locked. Forecast-vs-actual for it will read "not logged", not zero variance.'
          : 'Lock the official forecast before this month closes, or the accuracy score for it cannot be computed honestly.',
        citations: [],
      },
    ];
  },
};

/**
 * "Tell me when a division moves sharply against last month."
 *
 * A threshold goal only fires at a fixed line; this one catches a division
 * that is still inside its threshold but moving fast.
 */
const materialMovement: Evaluator = {
  id: 'MATERIAL_MOVEMENT',
  label: 'Large month-on-month movement',
  description:
    'Fires when a metric moves against the prior month by more than a stated percentage, in its unfavourable direction. Catches a sharp move that is still inside a fixed threshold.',
  params: [
    { name: 'kpi', label: 'Metric', required: true },
    { name: 'movePct', label: 'Movement that matters (e.g. 0.15)', required: true },
    { name: 'divisions', label: 'Divisions (blank = all)', required: false },
  ],
  run(context) {
    const kpiId = String(context.goal.params?.kpi ?? '');
    const definition = getKpiDefinition(kpiId);
    const trigger = numberParam(context.goal.params, 'movePct') ?? d(0.15);
    if (!definition) return [];

    const findings: Finding[] = [];

    for (const division of scopeOf(context)) {
      const current = resolveKpi(context.session, kpiId, division);
      const prior = resolveKpi(context.session, kpiId, division, {
        month: context.session.period.priorMonth,
      });

      if (current.value === null || prior.value === null || prior.value.isZero()) continue;

      const move = current.value.minus(prior.value).dividedBy(prior.value.abs());
      const unfavourable = definition.higherIsBetter ? move.isNegative() : move.isPositive();
      if (!unfavourable || move.abs().lessThan(trigger)) continue;

      findings.push({
        goalId: context.goal.id,
        goalName: context.goal.name,
        periodMonth: context.session.period.month,
        divisionCode: division === CONSOLIDATED_CODE ? null : division,
        severity: severityFor(move),
        headline: `${definition.name} moved ${move.times(100).toFixed(0)}% against prior month — ${division === CONSOLIDATED_CODE ? 'ARG Total' : division}`,
        detail: `${prior.formatted} in ${context.session.period.priorMonth.slice(0, 7)} to ${current.formatted} in ${context.session.period.month.slice(0, 7)}.`,
        citations: [...current.citations, ...prior.citations],
      });
    }

    return findings;
  },
};

export const EVALUATORS: Evaluator[] = [
  kpiThreshold,
  budgetAttainment,
  reconFailing,
  forecastNotLocked,
  materialMovement,
];

export function evaluatorById(id: string): Evaluator | undefined {
  return EVALUATORS.find((evaluator) => evaluator.id === id);
}

/** Published to the admin goal builder so the form is generated, not maintained. */
export function evaluatorCatalogue() {
  return EVALUATORS.map((evaluator) => ({
    id: evaluator.id,
    label: evaluator.label,
    description: evaluator.description,
    params: evaluator.params,
  }));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates one user's active goals for a month.
 *
 * The session is opened as the goal's owner, so a division manager's goal can
 * only ever produce findings about divisions that manager may see. Entitlements
 * are not re-checked here — they were applied when the facts were loaded.
 */
export async function evaluateGoalsForUser(
  db: Database,
  user: SessionUser,
  month: MonthKey,
  cadences: string[] = ['ON_REFRESH'],
): Promise<Finding[]> {
  const goals = await db
    .select()
    .from(t.agentGoal)
    .where(and(eq(t.agentGoal.userId, user.id), eq(t.agentGoal.isActive, true)));

  const due = goals.filter((goal) => cadences.includes(goal.cadence));
  if (due.length === 0) return [];

  const session = await openSemanticSession(db, user, month);
  const findings: Finding[] = [];

  for (const row of due) {
    const evaluator = evaluatorById(row.evaluator);
    if (!evaluator) continue;

    const goal: GoalRecord = {
      id: row.id,
      name: row.name,
      instruction: row.instruction,
      evaluator: row.evaluator,
      params: (row.params as Record<string, unknown> | null) ?? null,
      cadence: row.cadence,
      isActive: row.isActive,
    };

    try {
      findings.push(...(await evaluator.run({ db, session, goal })));
    } catch (error) {
      // A goal that throws is a broken goal, not a clean panel. Surface it
      // rather than letting the exception panel quietly under-report.
      findings.push({
        goalId: row.id,
        goalName: row.name,
        periodMonth: month,
        divisionCode: null,
        severity: 'serious',
        headline: `Goal "${row.name}" could not be evaluated`,
        detail: error instanceof Error ? error.message : 'Unknown error.',
        citations: [],
      });
    }

    await db
      .update(t.agentGoal)
      .set({ lastEvaluatedAt: new Date() })
      .where(eq(t.agentGoal.id, row.id));
  }

  return findings;
}

/**
 * Persists findings, collapsing repeats.
 *
 * An unchanged exception should not stack up a new row every night — the same
 * breach appearing thirty times reads as thirty problems. The unique index does
 * the collapsing; acknowledgement state survives it.
 */
export async function persistFindings(db: Database, findings: Finding[]): Promise<number> {
  if (findings.length === 0) return 0;

  await db
    .insert(t.agentFinding)
    .values(
      findings.map((finding) => ({
        goalId: finding.goalId,
        periodMonth: finding.periodMonth,
        divisionCode: finding.divisionCode,
        severity: finding.severity,
        headline: finding.headline,
        detail: finding.detail,
        citations: finding.citations.length ? (finding.citations as unknown as object) : null,
      })),
    )
    .onConflictDoNothing();

  return findings.length;
}

/** The open exceptions shown on the Executive panel, worst first. */
export async function openFindings(db: Database, user: SessionUser, month: MonthKey) {
  const rank: Record<string, number> = { critical: 0, serious: 1, warning: 2, good: 3 };

  const rows = await db
    .select({
      id: t.agentFinding.id,
      goalName: t.agentGoal.name,
      severity: t.agentFinding.severity,
      headline: t.agentFinding.headline,
      detail: t.agentFinding.detail,
      divisionCode: t.agentFinding.divisionCode,
      periodMonth: t.agentFinding.periodMonth,
      createdAt: t.agentFinding.createdAt,
    })
    .from(t.agentFinding)
    .leftJoin(t.agentGoal, eq(t.agentGoal.id, t.agentFinding.goalId))
    .where(
      and(
        eq(t.agentFinding.isAcknowledged, false),
        eq(t.agentFinding.periodMonth, month),
        eq(t.agentGoal.userId, user.id),
      ),
    );

  // A finding about a division the reader cannot see must not appear, even
  // though the goal was theirs — entitlements can be narrowed after the fact.
  return rows
    .filter(
      (row) =>
        row.divisionCode === null || user.canViewConsolidated || user.divisionCodes.includes(row.divisionCode),
    )
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

/**
 * The goals every new deployment starts with.
 *
 * Chosen so the exception panel is useful on day one rather than empty until
 * somebody thinks to configure it. Each maps to something §13 or §8 asks for.
 */
export const DEFAULT_GOALS: Array<Omit<GoalRecord, 'id' | 'isActive'>> = [
  {
    name: 'Numbers tie to source',
    instruction: 'Tell me immediately if any reconciliation control stops passing.',
    evaluator: 'RECON_FAILING',
    params: null,
    cadence: 'ON_REFRESH',
  },
  {
    name: 'Division gross margin holds',
    instruction: 'Flag any division whose gross margin falls below 35%.',
    evaluator: 'KPI_THRESHOLD',
    params: { kpi: 'gross_profit_pct', threshold: 0.35 },
    cadence: 'ON_REFRESH',
  },
  {
    name: 'Revenue tracks budget',
    instruction: 'Tell me when a division comes in under 90% of its revenue budget.',
    evaluator: 'BUDGET_ATTAINMENT',
    params: { lineItem: 'revenue', minAttainment: 0.9 },
    cadence: 'ON_REFRESH',
  },
  {
    name: 'Operating expense discipline',
    instruction: 'Flag a division whose operating expense jumps more than 15% on the month.',
    evaluator: 'MATERIAL_MOVEMENT',
    params: { kpi: 'opex', movePct: 0.15 },
    cadence: 'ON_REFRESH',
  },
  {
    name: 'Forecast locked before close',
    instruction: 'Do not let a month close without an official locked forecast.',
    evaluator: 'FORECAST_NOT_LOCKED',
    params: null,
    cadence: 'ON_REFRESH',
  },
];
