import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { can } from '@/lib/auth/scope';
import type { SessionUser } from '@/lib/auth/session';
import { formatMonth, monthRange, addMonths, type MonthKey } from '@/lib/semantic/periods';
import { KPI_REGISTRY, getKpiDefinition, isSpecKpi } from '@/lib/semantic/registry';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { sumPl, key } from '@/lib/semantic/facts';
import { connectorStatuses, getConnector, type SourceSystemCode } from '@/lib/connectors';
import { executeViewSpec, viewSpecJsonSchema, ViewSpecError } from './viewspec';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * The agent's tools.
 *
 * Two things are true of this list and are the whole design:
 *
 *   1. There is no raw-SQL tool and no free-text number path. Every read goes
 *      through `resolveKpi`, the same function the dashboards call. The agent is
 *      structurally incapable of computing a metric a second, different way.
 *
 *   2. There is no write tool for QuickBooks or HubSpot. Sources are read-only
 *      by absence, not by a flag someone could flip (§2 Rule 7).
 *
 * Ingestion tools exist, but they plan and preview; nothing is committed until a
 * human confirms, and every commit is one reversible `load_run`.
 */

export interface ToolContext {
  /**
   * The connection the caller opened. Tools never reach for the global
   * singleton: the agent must read and write the same database its semantic
   * session was loaded from, or a preview and its confirmation can land in two
   * different places.
   */
  db: Database;
  user: SessionUser;
  session: SemanticSession;
  conversationId: string | null;
}

export interface ToolOutcome {
  /** Returned to the model as the tool result. */
  result: unknown;
  /** A resolved chart to render in the transcript. */
  view?: ChartCardProps;
  /** A pending write awaiting human confirmation. */
  pendingAction?: { id: string; label: string; detail: string };
  /** One line describing what happened, shown as agent activity. */
  activity?: string;
  citations?: Array<{ label: string; value: string; source: string; periodMonth?: string; divisionCode?: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIVISION_ARG = {
  type: 'string',
  description:
    'Division code, or "ARG_TOTAL" for the consolidated rollup. Defaults to the division the user is currently viewing.',
};

const MONTH_ARG = {
  type: 'string',
  description:
    'Reporting month as YYYY-MM. Defaults to the month the user is currently viewing.',
};

function normaliseMonth(value: unknown, fallback: MonthKey): MonthKey {
  if (typeof value !== 'string') return fallback;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return fallback;
}

function divisionOf(value: unknown, context: ToolContext): string {
  if (typeof value !== 'string') {
    return context.session.consolidatedAvailable
      ? CONSOLIDATED_CODE
      : (context.session.visibleDivisions[0] ?? CONSOLIDATED_CODE);
  }
  return value;
}

/**
 * §11 Requirement 3: the tool returns a typed unavailable rather than a null,
 * so there is nothing for the model to guess from. It cannot mistake "no data"
 * for "zero" because it never receives a zero.
 */
function kpiPayload(session: SemanticSession, id: string, divisionCode: string, month: MonthKey, options?: Record<string, string | number | boolean>) {
  const result = resolveKpi(session, id, divisionCode, { month, options });

  if (result.unavailable) {
    return {
      metric: result.name,
      division: divisionCode,
      period: formatMonth(month),
      available: false as const,
      reason: result.unavailable.reason,
      explanation: result.unavailable.detail,
      instruction:
        'This figure is not available. Say so and explain why. Do not estimate, approximate, or substitute a different metric.',
    };
  }

  return {
    metric: result.name,
    division: divisionCode,
    period: formatMonth(month),
    available: true as const,
    value: result.formatted,
    rawValue: result.value!.toNumber(),
    periodState: result.periodState,
    preliminary: result.periodState === 'OPEN',
    higherIsBetter: result.higherIsBetter,
    citations: result.citations,
    verifyHref: result.verifyHref,
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const listKpis: ToolDefinition = {
  name: 'list_kpis',
  description:
    'List the metrics this system defines, with their formulas and sources. Call this when you are unsure whether a metric exists or what exactly it measures. Never answer about a metric that is not in this list.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['finance', 'sales', 'marketing', 'operations', 'base'],
        description: 'Optional filter.',
      },
    },
  },
  async run(input) {
    const category = input.category as string | undefined;
    const items = KPI_REGISTRY.filter((k) => !category || k.category === category).map((k) => ({
      id: k.id,
      name: k.name,
      category: k.category,
      formula: k.formula,
      source: k.sourceSystem,
      higherIsBetter: k.higherIsBetter,
      isSpecificationKpi: isSpecKpi(k.id),
      notes: k.notes,
    }));
    return { result: { count: items.length, metrics: items } };
  },
};

const getKpi: ToolDefinition = {
  name: 'get_kpi',
  description:
    'Get one metric for one division and month. This is the only way to obtain a figure — never compute one yourself from other numbers.',
  input_schema: {
    type: 'object',
    required: ['metric'],
    properties: {
      metric: { type: 'string', description: 'Metric id from list_kpis.' },
      division: DIVISION_ARG,
      month: MONTH_ARG,
      options: {
        type: 'object',
        description:
          'Per-metric options. cash_runway accepts {"variant":"trailing_3m"}; budget_attainment accepts {"scenario":"MONTHLY_BUDGET"|"TENX","lineItem":"revenue"|"cogs"|"opex","scope":"month"|"ytd"}.',
        additionalProperties: true,
      },
    },
  },
  async run(input, context) {
    const month = normaliseMonth(input.month, context.session.period.month);
    const division = divisionOf(input.division, context);
    const payload = kpiPayload(
      context.session,
      String(input.metric),
      division,
      month,
      input.options as Record<string, string | number | boolean> | undefined,
    );
    return {
      result: payload,
      citations: payload.available ? payload.citations.map((c) => ({ ...c, source: String(c.source) })) : [],
      activity: `Read ${payload.metric} · ${division} · ${payload.period}`,
    };
  },
};

const comparePeriods: ToolDefinition = {
  name: 'compare_periods',
  description:
    'Compare one metric across two periods, or against budget. Returns both figures and the change, with the direction already judged for you — use the reported "assessment", never your own reading of whether the number went up.',
  input_schema: {
    type: 'object',
    required: ['metric'],
    properties: {
      metric: { type: 'string' },
      division: DIVISION_ARG,
      month: MONTH_ARG,
      against: {
        type: 'string',
        enum: ['prior_month', 'prior_year', 'budget', 'tenx'],
        description: 'What to compare to. Defaults to prior_month.',
      },
    },
  },
  async run(input, context) {
    const { session } = context;
    const month = normaliseMonth(input.month, session.period.month);
    const division = divisionOf(input.division, context);
    const metric = String(input.metric);
    const against = (input.against as string) ?? 'prior_month';

    const definition = getKpiDefinition(metric);
    if (!definition) {
      return { result: { error: `Unknown metric "${metric}". Call list_kpis first.` } };
    }

    if (against === 'budget' || against === 'tenx') {
      const scenario = against === 'tenx' ? 'TENX' : 'MONTHLY_BUDGET';

      /**
       * Which budget lines this metric is made of.
       *
       * The budget carries three lines — revenue, COGS and OpEx. Gross and net
       * profit are derived from them by the same identity the rest of the system
       * uses, never imported, so a budgeted gross profit always equals budgeted
       * revenue minus budgeted COGS.
       *
       * Anything not on this list has no budget, and that is the whole answer.
       * This previously fell back to comparing REVENUE while labelling the
       * result with the requested metric's name. Asking for LITS gross profit
       * against budget in March 2026 returned revenue of $203,363 against the
       * revenue plan of $124,620 — titled "Gross Profit", at 163% attainment.
       * The real figures are gross profit of $123,919 against a gross-profit
       * plan of $44,425. Both the actual and the plan were the wrong line, and
       * nothing in the response said so. A wrong figure under a confident label
       * is the exact failure this system exists to prevent, and a silent
       * substitution is how it got there.
       */
      const COMPOSITION: Record<string, Array<{ lineItem: 'revenue' | 'cogs' | 'opex'; sign: 1 | -1 }>> = {
        revenue: [{ lineItem: 'revenue', sign: 1 }],
        cogs: [{ lineItem: 'cogs', sign: 1 }],
        opex: [{ lineItem: 'opex', sign: 1 }],
        gross_profit: [
          { lineItem: 'revenue', sign: 1 },
          { lineItem: 'cogs', sign: -1 },
        ],
        net_profit: [
          { lineItem: 'revenue', sign: 1 },
          { lineItem: 'cogs', sign: -1 },
          { lineItem: 'opex', sign: -1 },
        ],
      };

      const composition = COMPOSITION[metric];
      if (!composition) {
        return {
          result: {
            available: false,
            reason: 'NO_BUDGET_FOR_METRIC',
            explanation:
              `The budget carries revenue, COGS and OpEx. ${definition.name} is not budgeted and ` +
              `cannot be derived from those three, so there is no plan figure to compare against. ` +
              `Tell the user that plainly. Comparing ${definition.name} to a different line's ` +
              `budget would be a wrong number under a confident label.`,
            budgetedMetrics: Object.keys(COMPOSITION),
          },
        };
      }

      let actualTotal: number | null = 0;
      let budgetTotal: number | null = 0;

      for (const part of composition) {
        const attainment = resolveKpi(session, 'budget_attainment', division, {
          month,
          options: { scenario, lineItem: part.lineItem },
        });
        if (attainment.unavailable) {
          return {
            result: {
              available: false,
              reason: attainment.unavailable.reason,
              explanation: attainment.unavailable.detail,
            },
          };
        }
        const partActual = attainment.components?.actual?.toNumber();
        const partBudget = attainment.components?.budget?.toNumber();
        if (partActual === undefined || partBudget === undefined) {
          actualTotal = null;
          budgetTotal = null;
          break;
        }
        actualTotal = (actualTotal ?? 0) + part.sign * partActual;
        budgetTotal = (budgetTotal ?? 0) + part.sign * partBudget;
      }

      if (actualTotal === null || budgetTotal === null) {
        return {
          result: {
            available: false,
            reason: 'NO_DATA',
            explanation: `The ${scenario} figures for ${definition.name} could not be resolved.`,
          },
        };
      }

      const actual = actualTotal;
      const budget = budgetTotal;
      const variance = actual - budget;
      const favourable = variance === 0 ? null : definition.higherIsBetter ? variance > 0 : variance < 0;

      return {
        result: {
          metric: definition.name,
          division,
          period: formatMonth(month),
          // Named so they cannot be mistaken for one another. These are the
          // figures for THIS metric, not for any line it was derived from.
          actualLabel: `${definition.name} actual`,
          actual,
          planLabel: `${definition.name} plan`,
          plan: budget,
          attainmentPercent: budget === 0 ? null : actual / budget,
          varianceDollars: variance,
          derivedFrom:
            composition.length > 1
              ? composition
                  .map((part) => `${part.sign === 1 ? '+' : '−'}${part.lineItem}`)
                  .join(' ')
              : undefined,
          assessment:
            favourable === null ? 'unchanged' : favourable ? 'favourable' : 'unfavourable',
          directionNote: definition.higherIsBetter
            ? 'Higher is better for this line, so above plan is favourable.'
            : 'Lower is better for this line — above plan means overspending, which is unfavourable.',
          instruction:
            'Quote actual and plan as the figures for this metric. They are not revenue unless ' +
            'the metric is revenue.',
        },
        activity: `Compared ${definition.name} against ${scenario}`,
      };
    }

    const comparisonMonth =
      against === 'prior_year' ? addMonths(month, -12) : addMonths(month, -1);

    const current = kpiPayload(session, metric, division, month);
    const prior = kpiPayload(session, metric, division, comparisonMonth);

    if (!current.available || !prior.available) {
      return {
        result: {
          available: false,
          explanation: !current.available ? current.explanation : prior.explanation,
        },
      };
    }

    const delta = current.rawValue - prior.rawValue;
    const favourable = delta === 0 ? null : definition.higherIsBetter ? delta > 0 : delta < 0;

    return {
      result: {
        metric: definition.name,
        division,
        current: { period: current.period, value: current.value },
        comparison: { period: prior.period, value: prior.value },
        change: delta,
        assessment: favourable === null ? 'unchanged' : favourable ? 'favourable' : 'unfavourable',
        directionNote: definition.higherIsBetter
          ? 'Higher is better for this metric.'
          : 'Lower is better for this metric — an increase is unfavourable.',
      },
      activity: `Compared ${definition.name} · ${formatMonth(month)} vs ${formatMonth(comparisonMonth)}`,
    };
  },
};

const getPlStatement: ToolDefinition = {
  name: 'get_pl_statement',
  description:
    'Get the full profit-and-loss for a division and month: revenue, COGS, gross profit, OpEx, net profit, and the two payroll memo lines. Use this instead of several get_kpi calls when the question is about overall performance.',
  input_schema: {
    type: 'object',
    properties: { division: DIVISION_ARG, month: MONTH_ARG },
  },
  async run(input, context) {
    const month = normaliseMonth(input.month, context.session.period.month);
    const division = divisionOf(input.division, context);
    const lines = ['revenue', 'payroll_direct', 'cogs', 'gross_profit', 'payroll_expense', 'opex', 'net_profit'];

    const statement: Record<string, unknown> = {};
    for (const id of lines) {
      statement[id] = kpiPayload(context.session, id, division, month);
    }

    return {
      result: {
        division,
        period: formatMonth(month),
        basis: context.session.accountingBasis,
        periodState: context.session.bundle.periodState.get(month)?.isClosed ? 'CLOSED' : 'OPEN',
        lines: statement,
        memoNote:
          'payroll_direct is already inside cogs and payroll_expense is already inside opex. They are shown for visibility and must never be subtracted a second time.',
      },
      activity: `Read the P&L · ${division} · ${formatMonth(month)}`,
    };
  },
};

const getVarianceDrivers: ToolDefinition = {
  name: 'get_variance_drivers',
  description:
    'Break a reporting line down to the individual GL accounts behind it, and show how each moved against the prior month. This is what lets you say WHY a line moved rather than only that it did.',
  input_schema: {
    type: 'object',
    required: ['line'],
    properties: {
      line: {
        type: 'string',
        enum: ['revenue', 'cogs', 'opex'],
        description: 'Which reporting line to break down.',
      },
      division: DIVISION_ARG,
      month: MONTH_ARG,
    },
  },
  async run(input, context) {
    const { session } = context;
    const month = normaliseMonth(input.month, session.period.month);
    const division = divisionOf(input.division, context);
    const line = String(input.line);

    const divisions = division === CONSOLIDATED_CODE ? session.visibleDivisions : [division];
    const priorMonth = addMonths(month, -1);

    const totals = new Map<string, { name: string; current: Decimal; prior: Decimal }>();

    for (const code of divisions) {
      for (const [target, monthKey] of [
        ['current', month],
        ['prior', priorMonth],
      ] as const) {
        for (const detail of session.bundle.gl.get(key(monthKey, code)) ?? []) {
          // The memo payroll accounts belong to their parent line, so a COGS
          // breakdown includes direct payroll and an OpEx breakdown includes
          // administrative payroll.
          const belongs =
            (line === 'revenue' && detail.reportingLine === 'revenue') ||
            (line === 'cogs' && (detail.reportingLine === 'cogs' || detail.reportingLine === 'payroll_direct')) ||
            (line === 'opex' && (detail.reportingLine === 'opex' || detail.reportingLine === 'payroll_expense'));
          if (!belongs) continue;

          const entry = totals.get(detail.accountId) ?? {
            name: detail.accountName,
            current: new Decimal(0),
            prior: new Decimal(0),
          };
          entry[target] = entry[target].plus(detail.amount);
          totals.set(detail.accountId, entry);
        }
      }
    }

    if (totals.size === 0) {
      return {
        result: {
          available: false,
          explanation: `No account-level detail is loaded for ${division} in ${formatMonth(month)}.`,
        },
      };
    }

    const accounts = [...totals.entries()]
      .map(([accountId, entry]) => ({
        accountId,
        accountName: entry.name,
        current: entry.current.toNumber(),
        priorMonth: entry.prior.toNumber(),
        change: entry.current.minus(entry.prior).toNumber(),
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      result: {
        line,
        division,
        period: formatMonth(month),
        comparedTo: formatMonth(priorMonth),
        accounts: accounts.slice(0, 15),
        note: 'Accounts are ordered by the size of the movement, largest first.',
      },
      activity: `Broke ${line} down to ${accounts.length} accounts`,
    };
  },
};

const getPeriodState: ToolDefinition = {
  name: 'get_period_state',
  description:
    'Check whether a month is closed. Any figure from an open month is preliminary and must be labelled as such in your answer.',
  input_schema: { type: 'object', properties: { month: MONTH_ARG } },
  async run(input, context) {
    const month = normaliseMonth(input.month, context.session.period.month);
    const state = context.session.bundle.periodState.get(month);
    return {
      result: {
        period: formatMonth(month),
        exists: Boolean(state),
        isClosed: state?.isClosed ?? false,
        instruction: state?.isClosed
          ? 'Books are closed. Figures are final.'
          : 'Books are NOT closed. Every figure from this month is preliminary and will change — say so.',
      },
    };
  },
};

const getReconStatus: ToolDefinition = {
  name: 'get_recon_status',
  description:
    'Check whether the standing reconciliation controls are passing. If any are failing, say so before quoting figures — they may not tie to source.',
  input_schema: { type: 'object', properties: {} },
  async run(_input, context) {
    const rows = await context.db
      .select({
        checkName: t.reconResult.checkName,
        status: t.reconResult.status,
        detail: t.reconResult.detail,
        divisionCode: t.reconResult.divisionCode,
        periodMonth: t.reconResult.periodMonth,
      })
      .from(t.reconResult)
      .where(sql`ran_at = (select max(ran_at) from recon_result)`);

    const failing = rows.filter((row) => row.status === 'FAIL');
    return {
      result: {
        totalChecks: rows.length,
        passing: rows.filter((row) => row.status === 'PASS').length,
        failing: failing.length,
        failures: failing.slice(0, 10),
        instruction:
          failing.length === 0
            ? 'All controls pass. Figures tie to source.'
            : 'Controls are failing. Warn the user before quoting any figure that depends on the affected area.',
      },
      activity: `Checked ${rows.length} reconciliation controls`,
    };
  },
};

const makeChart: ToolDefinition = {
  name: 'make_chart',
  description:
    'Render a chart or table from the metrics registry. You describe what to plot; the system resolves the figures and draws it with the same components the dashboards use. Do not describe numbers in text that you are also plotting — the chart carries them.',
  input_schema: viewSpecJsonSchema(),
  async run(input, context) {
    try {
      const executed = executeViewSpec(context.session, input);
      return {
        result: {
          rendered: true,
          summary: executed.summary,
          instruction:
            'The chart is now visible to the user. Describe what it shows in one or two sentences; do not list the values.',
        },
        view: executed.chart,
        activity: `Built a chart: ${executed.chart.title}`,
      };
    } catch (error) {
      if (error instanceof ViewSpecError) {
        return { result: { rendered: false, error: error.message } };
      }
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// Ingestion tools — plan, preview, confirm
// ---------------------------------------------------------------------------

const listSources: ToolDefinition = {
  name: 'list_sources',
  description:
    'List the connected source systems and what can be pulled from each. Call this before proposing an extraction so you name a real source and entity.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return {
      result: {
        sources: (await connectorStatuses()).map((connector) => ({
          source: connector.sourceSystem,
          label: connector.label,
          connected: connector.isConfigured,
          entities: connector.entities.map((entity) => ({
            entity: entity.entity,
            label: entity.label,
            cadence: entity.cadence,
            description: entity.description,
          })),
        })),
        note: 'A source marked connected:false has no credentials configured. Say so plainly rather than attempting a pull.',
      },
    };
  },
};

const planExtraction: ToolDefinition = {
  name: 'plan_extraction',
  description:
    'Propose pulling data from a source system. This does NOT write anything — it records a plan and asks the user to confirm. Use it whenever the user asks you to refresh, pull, load, or import data.',
  input_schema: {
    type: 'object',
    required: ['source', 'entity'],
    properties: {
      source: {
        type: 'string',
        enum: ['QBO', 'HUBSPOT', 'SHEETS'],
        description: 'Which source system to read from.',
      },
      entity: { type: 'string', description: 'Which entity, from list_sources.' },
      fromMonth: { type: 'string', description: 'First month to pull, as YYYY-MM.' },
      toMonth: { type: 'string', description: 'Last month to pull, as YYYY-MM.' },
      reason: { type: 'string', description: 'One line on why this pull is being proposed.' },
    },
  },
  async run(input, context) {
    if (!can(context.user, 'RUN_INGESTION')) {
      return {
        result: {
          permitted: false,
          explanation:
            'This user is not permitted to run ingestion. Tell them who can (an administrator or the CFO) rather than attempting it.',
        },
      };
    }

    const source = String(input.source) as SourceSystemCode;
    const entity = String(input.entity);
    const connector = getConnector(source);

    if (!connector.entities().some((candidate) => candidate.entity === entity)) {
      return {
        result: {
          error: `"${entity}" is not an entity ${connector.label} exposes. Call list_sources.`,
        },
      };
    }

    const fallbackFrom = addMonths(context.session.period.month, -2);
    const windowStart = normaliseMonth(input.fromMonth, fallbackFrom);
    const windowEnd = normaliseMonth(input.toMonth, context.session.period.month);
    const months = monthRange(windowStart, windowEnd);

    // Closed months are frozen. Saying so up front is better than proposing a
    // pull that the database would reject.
    const closed = months.filter((month) => context.session.bundle.periodState.get(month)?.isClosed);

    const [run] = await context.db
      .insert(t.loadRun)
      .values({
        sourceSystem: source,
        entity,
        windowStart,
        windowEnd,
        status: 'PREVIEW',
        requestedByUserId: context.user.id,
        agentConversationId: context.conversationId,
        plan: {
          reason: input.reason ?? null,
          months: months.length,
          closedMonths: closed,
          connected: await connector.isConfigured(),
        },
      })
      .returning();

    return {
      result: {
        planned: true,
        loadRunId: run!.id,
        source: connector.label,
        entity,
        window: `${windowStart.slice(0, 7)} → ${windowEnd.slice(0, 7)}`,
        months: months.length,
        connected: await connector.isConfigured(),
        closedMonthsInWindow: closed.map((month) => month.slice(0, 7)),
        instruction: (await connector.isConfigured())
          ? 'Nothing has been written. Tell the user what you plan to pull and that they must confirm it. The confirm control is already on screen — do not ask them to type anything.'
          : `${connector.label} has no credentials configured, so this pull cannot run yet. Say so plainly and stop; do not pretend to have pulled anything.`,
      },
      pendingAction: {
        id: run!.id,
        label: `Pull ${entity.replace(/_/g, ' ')} from ${connector.label}`,
        detail: `${windowStart.slice(0, 7)} through ${windowEnd.slice(0, 7)} · ${months.length} month${months.length === 1 ? '' : 's'}${
          closed.length ? ` · ${closed.length} closed month${closed.length === 1 ? '' : 's'} will be skipped` : ''
        }${(await connector.isConfigured()) ? '' : ' · source not connected'}`,
      },
      activity: `Prepared a ${connector.label} extraction for review`,
    };
  },
};

const getLoadHistory: ToolDefinition = {
  name: 'get_load_history',
  description: 'Show recent data loads: what ran, when, how many rows, and whether it succeeded.',
  input_schema: { type: 'object', properties: {} },
  async run(_input, context) {
    const runs = await context.db
      .select()
      .from(t.loadRun)
      .orderBy(desc(t.loadRun.startedAt))
      .limit(10);

    return {
      result: {
        runs: runs.map((run) => ({
          id: run.id,
          source: run.sourceSystem,
          entity: run.entity,
          status: run.status,
          window: run.windowStart ? `${run.windowStart.slice(0, 7)} → ${run.windowEnd?.slice(0, 7)}` : null,
          rowsWritten: run.rowsWritten,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          error: run.errorMessage,
        })),
      },
    };
  },
};


/**
 * Where the figures on screen actually came from.
 *
 * The question this answers — "am I looking at ARG's books or at seeded data?" —
 * is the one a reader most needs answered and the one an application is most
 * likely to leave ambiguous. Every fact table carries its source system, so the
 * answer is read from the rows themselves rather than inferred from whether a
 * connector happens to hold a credential.
 */
const getDataProvenance: ToolDefinition = {
  name: 'get_data_provenance',
  description:
    'Report where the figures currently in the warehouse came from: which source system wrote each fact table, when, and whether any of it is still seeded demonstration data rather than the live books. Call this whenever the user asks whether the numbers are real, live, seeded or up to date.',
  input_schema: { type: 'object', properties: {} },
  async run(_input, context) {
    const [plSources, dealCount, budgetSources, lastLoads, connectors] = await Promise.all([
      context.db
        .select({
          sourceSystem: t.factPlActual.sourceSystem,
          months: sql<number>`count(distinct ${t.factPlActual.periodMonth})::int`,
          earliest: sql<string>`min(${t.factPlActual.periodMonth})::text`,
          latest: sql<string>`max(${t.factPlActual.periodMonth})::text`,
        })
        .from(t.factPlActual)
        .groupBy(t.factPlActual.sourceSystem),
      context.db.select({ count: sql<number>`count(*)::int` }).from(t.factDeal),
      context.db
        .select({
          sourceSystem: t.factBudget.sourceSystem,
          rows: sql<number>`count(*)::int`,
        })
        .from(t.factBudget)
        .groupBy(t.factBudget.sourceSystem),
      context.db
        .select()
        .from(t.loadRun)
        .where(eq(t.loadRun.status, 'SUCCEEDED'))
        .orderBy(desc(t.loadRun.finishedAt))
        .limit(5),
      connectorStatuses(),
    ]);

    const seeded = plSources.filter((row) => row.sourceSystem === 'SEED');
    const live = plSources.filter((row) => row.sourceSystem !== 'SEED');

    return {
      result: {
        profitAndLoss: plSources.map((row) => ({
          sourceSystem: row.sourceSystem,
          months: row.months,
          window: `${row.earliest?.slice(0, 7)} → ${row.latest?.slice(0, 7)}`,
        })),
        budgetRows: budgetSources,
        dealCount: dealCount[0]?.count ?? 0,
        sourcesConnected: connectors.map((connector) => ({
          source: connector.sourceSystem,
          connected: connector.isConfigured,
          account: connector.credential.accountLabel,
        })),
        recentLoads: lastLoads.map((run) => ({
          source: run.sourceSystem,
          entity: run.entity,
          rowsWritten: run.rowsWritten,
          finishedAt: run.finishedAt?.toISOString() ?? null,
        })),
        verdict: live.length === 0
          ? 'Every profit-and-loss row in the warehouse is seeded demonstration data. No month has been loaded from a source system.'
          : seeded.length === 0
            ? 'Every profit-and-loss row was loaded from a source system. Nothing seeded remains.'
            : 'The warehouse holds a mix: some months are seeded and some were loaded from a source system. Name which are which from the windows above.',
        instruction:
          'Answer this plainly and without softening it. A reader who believes seeded figures are their own books will act on them.',
      },
      activity: 'Checked where the figures in the warehouse came from',
    };
  },
};

/**
 * The connection state, and what to do about it.
 *
 * Distinct from list_sources, which describes what each source can supply. This
 * one answers "why can I not see my own numbers yet", which is a different
 * question and the one people actually ask.
 */
const getConnectionStatus: ToolDefinition = {
  name: 'get_connection_status',
  description:
    'Report whether each source system is signed in, which account it is signed in to, and what remains to be done before it can supply data. Call this when the user asks about connecting QuickBooks, HubSpot or Google Sheets, or reports that a connection is not working.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const connectors = await connectorStatuses();

    return {
      result: {
        sources: connectors.map((connector) => ({
          source: connector.sourceSystem,
          label: connector.label,
          connected: connector.isConfigured,
          account: connector.credential.accountLabel,
          signInAvailable: connector.oauthAvailable,
          signInLabel: connector.signInLabel,
          howToConnect: connector.oauthAvailable
            ? `Open Admin and choose "${connector.signInLabel}". Nothing else is needed — no token, no key file.`
            : connector.oauthBlockedReason,
          needsSpreadsheet: connector.needsSpreadsheet,
          lastError: connector.credential.lastError,
        })),
        instruction:
          'Tell the user exactly which step is outstanding. Do not describe a source as connected unless connected is true.',
      },
      activity: 'Checked the state of every source connection',
    };
  },
};

// ---------------------------------------------------------------------------

export const AGENT_TOOLS: ToolDefinition[] = [
  listKpis,
  getKpi,
  comparePeriods,
  getPlStatement,
  getVarianceDrivers,
  getPeriodState,
  getReconStatus,
  makeChart,
  listSources,
  getConnectionStatus,
  getDataProvenance,
  planExtraction,
  getLoadHistory,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/**
 * Executes a confirmed extraction.
 *
 * This is the only path that writes source data on an agent's behalf, and it
 * runs only after a human clicked confirm. The run is recorded end to end so it
 * can be reversed.
 */
export async function confirmExtraction(
  db: Database,
  user: SessionUser,
  loadRunId: string,
): Promise<{ ok: boolean; message: string }> {
  if (!can(user, 'RUN_INGESTION')) {
    return { ok: false, message: 'You are not permitted to run ingestion.' };
  }

  const [run] = await db
    .select()
    .from(t.loadRun)
    .where(and(eq(t.loadRun.id, loadRunId), eq(t.loadRun.status, 'PREVIEW')))
    .limit(1);

  if (!run) {
    return { ok: false, message: 'That extraction is no longer awaiting confirmation.' };
  }

  const connector = getConnector(run.sourceSystem as SourceSystemCode);
  if (!(await connector.isConfigured())) {
    await db
      .update(t.loadRun)
      .set({
        status: 'FAILED',
        errorMessage: `${connector.label} has no credentials configured.`,
        finishedAt: new Date(),
      })
      .where(eq(t.loadRun.id, loadRunId));
    return {
      ok: false,
      message: `${connector.label} is not connected. Sign in to it in Admin, then run this again — nothing was written.`,
    };
  }

  await db
    .update(t.loadRun)
    .set({ status: 'RUNNING', confirmedAt: new Date() })
    .where(eq(t.loadRun.id, loadRunId));

  // The work itself lives in lib/etl/ingest.ts, shared with the Sync button in
  // Admin. A load started from a conversation and one started from a button must
  // produce the same run, the same provenance and the same reconciliation.
  const { executeLoadRun } = await import('@/lib/etl/ingest');
  const outcome = await executeLoadRun(db, user, run, 'AGENT_EXTRACTION_CONFIRMED');

  if (!outcome.ok) {
    // An unmapped class or account is not a bug to be worked around — it is a
    // question for Westport, and the message names exactly what to answer.
    return {
      ok: false,
      message: `The pull did not complete and the warehouse is unchanged: ${outcome.error}`,
    };
  }

  const summary =
    `Pulled ${outcome.recordsRead} record${outcome.recordsRead === 1 ? '' : 's'} from ` +
    `${connector.label} and wrote ${outcome.rowsWritten.toLocaleString()} row` +
    `${outcome.rowsWritten === 1 ? '' : 's'} into the warehouse. The dashboards now read ` +
    `${connector.label} for this window.`;

  return {
    ok: true,
    message: outcome.notes.length ? `${summary}\n\n${outcome.notes.join('\n')}` : summary,
  };
}

export { sumPl };
