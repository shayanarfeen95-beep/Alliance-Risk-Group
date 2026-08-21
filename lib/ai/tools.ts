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
import {
  BoxError,
  createBox,
  createBoxJsonSchema,
  listBoxes,
  removeBox,
  validateBoxInput,
  PINNABLE_PAGES,
} from './boxes';
import {
  ATTRIBUTION_RULES,
  loadHubspotMapping,
  observedAttributionValues,
  saveHubspotMapping,
  type AttributionRule,
} from '@/lib/connectors/hubspot-mapping';
import { buildGuide } from './guide';
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
  /**
   * Somewhere to go — a filtered dashboard, a box that was just built, the
   * mapping screen. Rendered as a button rather than a URL the reader has to
   * assemble from an explanation.
   */
  links?: Array<{ label: string; href: string }>;
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
      const lineItem = ['revenue', 'cogs', 'opex'].includes(metric) ? metric : 'revenue';
      const attainment = resolveKpi(session, 'budget_attainment', division, {
        month,
        options: { scenario, lineItem },
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
      const actual = attainment.components?.actual?.toNumber() ?? null;
      const budget = attainment.components?.budget?.toNumber() ?? null;
      const variance = attainment.components?.varianceDollars?.toNumber() ?? null;
      const favourable =
        variance === null ? null : definition.higherIsBetter ? variance > 0 : variance < 0;

      return {
        result: {
          metric: definition.name,
          division,
          period: formatMonth(month),
          actual,
          plan: budget,
          attainmentPercent: attainment.value!.toNumber(),
          varianceDollars: variance,
          assessment:
            favourable === null ? 'unknown' : favourable ? 'favourable' : 'unfavourable',
          directionNote: definition.higherIsBetter
            ? 'Higher is better for this line, so above plan is favourable.'
            : 'Lower is better for this line — above plan means overspending, which is unfavourable.',
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

// ---------------------------------------------------------------------------
// Building boxes — the assistant as dashboard builder
// ---------------------------------------------------------------------------

const createDashboardBox: ToolDefinition = {
  name: 'create_box',
  description:
    'Add a box — a KPI tile or a chart — to one of the dashboards, where it stays until removed. Use this whenever somebody asks for something to be ON a dashboard rather than answered in conversation: "put cash for Claims on the executive page", "add a chart of bookings by division to sales". What is saved is the specification, so the box re-resolves through the same definitions as every other figure and can never drift from them.',
  input_schema: createBoxJsonSchema(),
  async run(input, context) {
    try {
      const { page, title, spec } = validateBoxInput(context.session, input);
      const box = await createBox(
        context.db,
        context.user,
        context.conversationId,
        page,
        title,
        spec,
      );

      const href = `/${page}?month=${context.session.period.month.slice(0, 7)}`;

      return {
        result: {
          created: true,
          boxId: box.id,
          page,
          title,
          instruction:
            'The box is saved to that dashboard. Say what you added and where, in one sentence. The link to open it is already on screen — do not paste a URL.',
        },
        links: [{ label: `Open the ${page} dashboard`, href }],
        activity: `Added "${title}" to the ${page} dashboard`,
      };
    } catch (error) {
      if (error instanceof BoxError) {
        return { result: { created: false, error: error.message } };
      }
      throw error;
    }
  },
};

const listDashboardBoxes: ToolDefinition = {
  name: 'list_boxes',
  description:
    'List the boxes this person has had you build, and which dashboard each is on. Call it before adding something similar, and before removing anything.',
  input_schema: {
    type: 'object',
    properties: {
      page: { type: 'string', enum: [...PINNABLE_PAGES], description: 'Optional filter.' },
    },
  },
  async run(input, context) {
    const boxes = await listBoxes(
      context.db,
      context.user,
      input.page ? String(input.page) : undefined,
    );
    return {
      result: {
        count: boxes.length,
        boxes: boxes.map((box) => ({
          id: box.id,
          title: box.title,
          page: box.page,
          kind: box.spec.kind,
          created: box.createdAt,
        })),
      },
    };
  },
};

const removeDashboardBox: ToolDefinition = {
  name: 'remove_box',
  description:
    'Remove a box you previously added. Takes the box id from list_boxes. Only removes boxes belonging to the person you are talking to.',
  input_schema: {
    type: 'object',
    required: ['boxId'],
    properties: { boxId: { type: 'string', description: 'Box id from list_boxes.' } },
  },
  async run(input, context) {
    const removed = await removeBox(context.db, context.user, String(input.boxId));
    return {
      result: removed
        ? { removed: true }
        : { removed: false, error: 'No box of theirs has that id. Call list_boxes.' },
      activity: removed ? 'Removed a box from the dashboard' : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Mapping — the assistant as data mapper
// ---------------------------------------------------------------------------

const inspectDivisionMapping: ToolDefinition = {
  name: 'inspect_division_mapping',
  description:
    'Show how HubSpot deals are currently attributed to ARG divisions: the rule, the values HubSpot actually sent, how many deals carry each, and which of them are unmapped. Call this before proposing any mapping change, and whenever somebody asks why sales figures are missing for a division.',
  input_schema: { type: 'object', properties: {} },
  async run(_input, context) {
    const mapping = await loadHubspotMapping(context.db);
    const divisions = context.session.bundle.divisions.map((d) => d.divisionCode);
    const observed = await observedAttributionValues(context.db, mapping, divisions);

    const unmapped = observed.values.filter((row) => !row.mappedTo);

    return {
      result: {
        rule: mapping.rule,
        ruleOptions: ATTRIBUTION_RULES,
        property: mapping.property,
        confirmedByWestport: mapping.isConfirmed,
        divisions,
        landedDealsSampled: observed.sampledDeals,
        values: observed.values,
        unmappedValues: unmapped.map((row) => ({ value: row.value, deals: row.deals })),
        unattributedDeals: unmapped.reduce((sum, row) => sum + row.deals, 0),
        consequence:
          mapping.rule === 'none' || !mapping.isConfirmed
            ? 'Sales and marketing metrics report at ARG Total only. Divisional figures are withheld rather than computed on an unconfirmed rule.'
            : 'Sales and marketing metrics break down by division for every mapped value. Unmapped values are counted at ARG Total and absent from division rows.',
        instruction:
          'Never propose a mapping for a value on resemblance alone. If it is not obvious which division a value belongs to, ask — an attribution nobody agreed to moves revenue between divisional P&Ls and is invisible at ARG Total.',
      },
      activity: `Inspected the HubSpot division mapping (${observed.values.length} distinct values)`,
    };
  },
};

const proposeDivisionMapping: ToolDefinition = {
  name: 'propose_division_mapping',
  description:
    'Propose a change to the HubSpot division mapping. This writes nothing — it puts a confirmation control on screen and the user decides. Use it when somebody tells you which division a HubSpot value belongs to. Call inspect_division_mapping first so you propose against real values.',
  input_schema: {
    type: 'object',
    required: ['rule'],
    properties: {
      rule: {
        type: 'string',
        enum: ['deal_property', 'pipeline', 'owner', 'none'],
        description: 'Which field decides the division. "none" reports at ARG Total only.',
      },
      property: {
        type: 'string',
        description: 'The HubSpot deal property name, required when rule is deal_property.',
      },
      values: {
        type: 'array',
        description:
          'The value-to-division mappings to set. Include every value that should be mapped — the list replaces what is stored.',
        items: {
          type: 'object',
          required: ['value', 'division'],
          properties: {
            value: { type: 'string', description: 'The value exactly as HubSpot holds it.' },
            division: { type: 'string', description: 'The ARG division code.' },
          },
        },
      },
      confirmRule: {
        type: 'boolean',
        description:
          'Whether this marks the rule as confirmed by Westport. Only true if the user has said so — divisional metrics stay withheld until it is.',
      },
    },
  },
  async run(input, context) {
    if (!can(context.user, 'EDIT_MAPPINGS')) {
      return {
        result: {
          permitted: false,
          explanation:
            'This user cannot change the division mapping — an administrator or the CFO does. Tell them who, rather than attempting it.',
        },
      };
    }

    const rule = String(input.rule) as AttributionRule;
    if (!ATTRIBUTION_RULES.some((candidate) => candidate.id === rule)) {
      return { result: { error: `"${input.rule}" is not an attribution rule.` } };
    }

    const current = await loadHubspotMapping(context.db);
    const property = input.property ? String(input.property) : current.property;
    if (rule === 'deal_property' && !property) {
      return {
        result: {
          error:
            'Attributing by deal property needs the property name. Ask which HubSpot property carries the division.',
        },
      };
    }

    const divisions = context.session.bundle.divisions.map((d) => d.divisionCode);
    const requested = Array.isArray(input.values) ? (input.values as Array<Record<string, unknown>>) : [];

    const values: Record<string, string> = {};
    const rejected: string[] = [];
    for (const entry of requested) {
      const value = String(entry.value ?? '').trim();
      const division = String(entry.division ?? '').trim();
      if (!value || !division) continue;
      if (!divisions.includes(division)) {
        rejected.push(`${value} → ${division}`);
        continue;
      }
      values[value.toLowerCase()] = division;
    }

    if (rejected.length) {
      return {
        result: {
          error: `These name a division that does not exist or is not visible to this user: ${rejected.join(', ')}. The divisions are ${divisions.join(', ')}.`,
        },
      };
    }

    const [action] = await context.db
      .insert(t.agentPendingAction)
      .values({
        userId: context.user.id,
        conversationId: context.conversationId,
        kind: 'HUBSPOT_MAPPING',
        label: 'Apply the HubSpot division mapping',
        detail:
          rule === 'none'
            ? 'Attribution set to none — sales and marketing report at ARG Total only.'
            : `${Object.keys(values).length} value${Object.keys(values).length === 1 ? '' : 's'} mapped by ${rule}${property ? ` (${property})` : ''}. Applies to every deal already landed.`,
        payload: {
          rule,
          property,
          values,
          isConfirmed: Boolean(input.confirmRule),
        },
        status: 'PENDING',
      })
      .returning();

    return {
      result: {
        proposed: true,
        actionId: action!.id,
        rule,
        property,
        mappings: values,
        instruction:
          'Nothing has been written. Summarise what the mapping would do, including any value left unmapped and what that means. The confirm control is already on screen — do not ask them to type anything.',
      },
      pendingAction: {
        id: action!.id,
        label: 'Apply the HubSpot division mapping',
        detail: `${
          rule === 'none'
            ? 'Sales and marketing will report at ARG Total only.'
            : `${Object.keys(values).length} value${Object.keys(values).length === 1 ? '' : 's'} mapped. Re-applied to every deal already landed.`
        }`,
      },
      links: [{ label: 'Open the mapping screen', href: '/admin' }],
      activity: 'Prepared a division mapping for review',
    };
  },
};

// ---------------------------------------------------------------------------
// Guiding — the assistant as the person who knows the app
// ---------------------------------------------------------------------------

const guideMe: ToolDefinition = {
  name: 'guide_me',
  description:
    'Get the map of this application as it currently stands: what each dashboard answers, how the filters work, what is connected, what decisions are still unconfirmed, what this person is permitted to do, and which boxes they have already had you build. Call it for any "how do I…", "where is…", "why is this blank" or "what can you do" question rather than describing the app from memory.',
  input_schema: { type: 'object', properties: {} },
  async run(_input, context) {
    const guide = await buildGuide(context.db, context.user);
    return {
      result: {
        ...guide,
        instruction:
          'Answer with the two or three steps that actually do the thing, naming the control on screen. Do not recite the whole feature list.',
      },
      activity: 'Read the current state of the app',
    };
  },
};

const openView: ToolDefinition = {
  name: 'open_view',
  description:
    'Give the user a button that opens a dashboard at a specific month, division, date range or salesperson. Use it when the answer is easier seen than described, or when they ask to "show me" something a built dashboard already covers.',
  input_schema: {
    type: 'object',
    required: ['page'],
    properties: {
      page: {
        type: 'string',
        enum: ['executive', 'finance', 'sales', 'marketing', 'forecast', 'kpi-dictionary', 'admin'],
      },
      division: DIVISION_ARG,
      month: MONTH_ARG,
      range: {
        type: 'string',
        enum: ['this_month', 'last_3_months', 'last_6_months', 'ytd', 'last_12_months'],
        description: 'The date range for views that list dated events.',
      },
      owner: { type: 'string', description: 'A salesperson name, for the Sales deal table.' },
      label: { type: 'string', description: 'What the button should say.' },
    },
  },
  async run(input, context) {
    const page = String(input.page);
    const params = new URLSearchParams();

    const month = normaliseMonth(input.month, context.session.period.month);
    params.set('month', month.slice(0, 7));

    if (typeof input.division === 'string') {
      const division = input.division;
      const permitted =
        division === CONSOLIDATED_CODE
          ? context.session.consolidatedAvailable
          : context.session.visibleDivisions.includes(division);
      if (!permitted) {
        return {
          result: {
            error: `Not entitled to ${division}. Visible divisions: ${context.session.visibleDivisions.join(', ') || 'none'}.`,
          },
        };
      }
      params.set('division', division);
    }

    if (typeof input.range === 'string') params.set('range', input.range);
    if (typeof input.owner === 'string') params.set('owner', input.owner);

    const href = `/${page}?${params.toString()}`;
    const label = typeof input.label === 'string' && input.label.trim() ? input.label : `Open ${page}`;

    return {
      result: {
        opened: false,
        href,
        instruction:
          'The button is on screen. Say in one sentence what they will see there; do not paste the URL.',
      },
      links: [{ label, href }],
      activity: `Prepared a link to ${page}`,
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
  planExtraction,
  getLoadHistory,
  createDashboardBox,
  listDashboardBoxes,
  removeDashboardBox,
  inspectDivisionMapping,
  proposeDivisionMapping,
  guideMe,
  openView,
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
      message: `${connector.label} is not connected. Add its credentials in Admin, then run this again — nothing was written.`,
    };
  }

  await db
    .update(t.loadRun)
    .set({ status: 'RUNNING', confirmedAt: new Date() })
    .where(eq(t.loadRun.id, loadRunId));

  try {
    const batch = await connector.fetch(run.entity, {
      start: run.windowStart!,
      end: run.windowEnd!,
    });

    // Raw landing first, so conform can be re-run without re-hitting the API.
    for (let i = 0; i < batch.records.length; i += 200) {
      await db.insert(t.rawPayload).values(
        batch.records.slice(i, i + 200).map((record) => ({
          loadRunId,
          sourceSystem: batch.sourceSystem,
          entity: record.entity,
          payload: record.payload as object,
        })),
      );
    }

    // Conform: raw landing → facts. Without this step a load "succeeds" and
    // not one figure on a dashboard moves, which is the most misleading outcome
    // a pipeline can produce.
    let conformLine = '';
    let rowsWritten = 0;

    if (run.sourceSystem === 'HUBSPOT') {
      const { conformHubspot, describeConform } = await import('@/lib/etl/hubspot');
      const conformed = await conformHubspot(
        db,
        loadRunId,
        run.entity,
        batch.records.map((record) => ({ payload: record.payload })),
      );
      rowsWritten = conformed.written;
      conformLine = ` ${describeConform(conformed)}`;
    } else if (run.sourceSystem === 'QBO') {
      const { conformQbo, describeQboConform } = await import('@/lib/etl/qbo');
      const conformed = await conformQbo(
        db,
        loadRunId,
        run.entity,
        batch.records.map((record) => ({ payload: record.payload, key: record.key })),
      );
      rowsWritten = conformed.written;
      conformLine = ` ${describeQboConform(conformed)}`;
    } else if (run.sourceSystem === 'SHEETS') {
      const { conformSheets, describeSheetsConform } = await import('@/lib/etl/sheets');
      const conformed = await conformSheets(
        db,
        loadRunId,
        run.entity,
        batch.records.map((record) => ({ payload: record.payload })),
      );
      rowsWritten = conformed.written;
      conformLine = ` ${describeSheetsConform(conformed)}`;
    } else {
      conformLine = ` They are landed and queryable but not yet conformed.`;
    }

    await db
      .update(t.loadRun)
      .set({
        status: 'SUCCEEDED',
        rowsRead: batch.records.length,
        rowsWritten,
        finishedAt: new Date(),
      })
      .where(eq(t.loadRun.id, loadRunId));

    await db.insert(t.auditEvent).values({
      userId: user.id,
      action: 'AGENT_EXTRACTION_CONFIRMED',
      entity: 'load_run',
      entityId: loadRunId,
      detail: {
        source: run.sourceSystem,
        entity: run.entity,
        records: batch.records.length,
        rowsWritten,
      },
    });

    return {
      ok: true,
      message: `Pulled ${batch.records.length} record${batch.records.length === 1 ? '' : 's'} from ${connector.label}.${conformLine} Reconciliation runs next.`,
    };
  } catch (error) {
    await db
      .update(t.loadRun)
      .set({
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(t.loadRun.id, loadRunId));

    return {
      ok: false,
      message: `The pull failed and nothing was written: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

/**
 * Applies a proposal the agent made and a human confirmed.
 *
 * The payload comes from the database rather than the request, so what is
 * applied is exactly what was previewed. A confirmation that carried its own
 * payload would make the preview a decoration.
 */
export async function confirmPendingAction(
  db: Database,
  user: SessionUser,
  actionId: string,
): Promise<{ handled: boolean; ok: boolean; message: string }> {
  const [action] = await db
    .select()
    .from(t.agentPendingAction)
    .where(and(eq(t.agentPendingAction.id, actionId), eq(t.agentPendingAction.status, 'PENDING')))
    .limit(1);

  if (!action) return { handled: false, ok: false, message: '' };

  if (action.userId !== user.id) {
    return {
      handled: true,
      ok: false,
      message: 'That proposal belongs to someone else’s conversation.',
    };
  }

  if (action.kind !== 'HUBSPOT_MAPPING') {
    return { handled: true, ok: false, message: `Nothing knows how to apply "${action.kind}".` };
  }

  if (!can(user, 'EDIT_MAPPINGS')) {
    return {
      handled: true,
      ok: false,
      message:
        'You are not permitted to change the division mapping — an administrator or the CFO is. Nothing was changed.',
    };
  }

  const payload = action.payload as {
    rule: AttributionRule;
    property: string | null;
    values: Record<string, string>;
    isConfirmed: boolean;
  };

  await saveHubspotMapping(db, user, {
    rule: payload.rule,
    property: payload.property,
    values: payload.values,
    isConfirmed: payload.isConfirmed,
  });

  // Re-attribute what is already landed, so the warehouse is never half on the
  // old rule and half on the new one.
  const { reconformLandedHubspot, describeConform } = await import('@/lib/etl/hubspot');
  const conformed = await reconformLandedHubspot(db, 'deals');

  await db
    .update(t.agentPendingAction)
    .set({ status: 'APPLIED', appliedAt: new Date() })
    .where(eq(t.agentPendingAction.id, actionId));

  return {
    handled: true,
    ok: true,
    message:
      conformed.written === 0
        ? 'Mapping saved. No HubSpot deals are landed yet, so there was nothing to re-attribute — it applies to the next pull.'
        : `Mapping saved. ${describeConform(conformed)}`,
  };
}

export { sumPl };
