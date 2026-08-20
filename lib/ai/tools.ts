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
import { runSync } from '@/lib/etl/sync';
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
// Source detail — records, never metrics
// ---------------------------------------------------------------------------

/**
 * The three tools below answer "go and get me the actual rows".
 *
 * They exist because the honest answer to "pull the deals Scott closed in
 * March" was previously "I can tell you the total" — which is not what was
 * asked, and a system that cannot show its working is a system nobody audits.
 *
 * What keeps them from becoming a second definition of anything: each returns
 * *records*, never an aggregate that a KPI already defines. There is no tool
 * here that sums a column. If the model wants a total it must call `get_kpi`,
 * exactly as before, and the guarantee that the assistant and the dashboard
 * cannot disagree survives intact — because nothing here produces a figure that
 * a dashboard also produces.
 *
 * Entitlements come for free: deals and accounts are read from the semantic
 * session's bundle, which was loaded with the caller's division scope applied.
 * A division manager cannot reach another division's deals through these,
 * because those rows were never fetched.
 */

const queryDeals: ToolDefinition = {
  name: 'query_deals',
  description:
    'List individual HubSpot deals matching a filter — by owner, stage, pipeline, status or close date. Use this when the user wants to see the deals themselves ("which deals did Scott close in March", "what is sitting in proposal"), not a total. For any total, use get_kpi instead; this tool deliberately does not sum anything.',
  input_schema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Salesperson name, or "Unassigned". Partial names match.' },
      stage: { type: 'string', description: 'HubSpot deal stage id, e.g. proposalsent.' },
      pipeline: { type: 'string', description: 'HubSpot pipeline id.' },
      status: {
        type: 'string',
        enum: ['won', 'lost', 'open', 'closed', 'any'],
        description: 'Deal status. Defaults to any.',
      },
      division: DIVISION_ARG,
      fromMonth: { type: 'string', description: 'Earliest close month, YYYY-MM. Applies to closed deals.' },
      toMonth: { type: 'string', description: 'Latest close month, YYYY-MM.' },
      limit: { type: 'number', description: 'How many to return, newest first. Defaults to 25, maximum 100.' },
    },
  },
  async run(input, context) {
    const { session } = context;
    const status = (input.status as string) ?? 'any';
    const division = typeof input.division === 'string' ? input.division : null;
    const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);

    const from = input.fromMonth ? normaliseMonth(input.fromMonth, session.period.month) : null;
    const to = input.toMonth ? normaliseMonth(input.toMonth, session.period.month) : null;
    const fromDate = from ? monthRange(from, from)[0] : null;
    const toBound = to ? addMonths(to, 1) : null;

    const owner = typeof input.owner === 'string' ? input.owner.toLowerCase() : null;

    const matched = session.bundle.deals.filter((deal) => {
      if (division && division !== CONSOLIDATED_CODE && deal.divisionCode !== division) return false;
      if (input.stage && deal.dealstage !== input.stage) return false;
      if (input.pipeline && deal.pipeline !== input.pipeline) return false;

      if (status === 'won' && !deal.isClosedWon) return false;
      if (status === 'lost' && !(deal.isClosed && !deal.isClosedWon)) return false;
      if (status === 'open' && deal.isClosed) return false;
      if (status === 'closed' && !deal.isClosed) return false;

      if (owner) {
        const name = (deal.ownerName ?? 'Unassigned').toLowerCase();
        if (!name.includes(owner)) return false;
      }

      if (fromDate || toBound) {
        if (!deal.closedate) return false;
        const closed = deal.closedate.toISOString().slice(0, 10);
        if (fromDate && closed < fromDate) return false;
        if (toBound && closed >= toBound) return false;
      }

      return true;
    });

    const sorted = [...matched].sort((a, b) => {
      const left = a.closedate?.getTime() ?? a.createdate?.getTime() ?? 0;
      const right = b.closedate?.getTime() ?? b.createdate?.getTime() ?? 0;
      return right - left;
    });

    return {
      result: {
        matched: matched.length,
        returned: Math.min(sorted.length, limit),
        deals: sorted.slice(0, limit).map((deal) => ({
          dealId: deal.dealId,
          name: deal.dealName,
          amount: deal.amount.toNumber(),
          owner: deal.ownerName ?? 'Unassigned',
          stage: deal.dealstage,
          pipeline: deal.pipeline,
          division: deal.divisionCode,
          status: deal.isClosedWon ? 'won' : deal.isClosed ? 'lost' : 'open',
          created: deal.createdate?.toISOString().slice(0, 10) ?? null,
          closed: deal.closedate?.toISOString().slice(0, 10) ?? null,
        })),
        note:
          'Individual deals as loaded from HubSpot. Do not add these amounts up and present the ' +
          'result as a metric — call get_kpi for Dollars Booked or Pipeline Value, which apply ' +
          "ARG's definitions. Deals outside this user's divisions were never loaded.",
      },
      activity: `Found ${matched.length} deal${matched.length === 1 ? '' : 's'} in HubSpot`,
    };
  },
};

const queryGlAccounts: ToolDefinition = {
  name: 'query_gl_accounts',
  description:
    'List the individual QuickBooks GL accounts and their balances for one division and month. Use this to answer "what is actually in OpEx" or "which account is that cost sitting in". For the reporting-line totals use get_pl_statement, and for what moved use get_variance_drivers.',
  input_schema: {
    type: 'object',
    properties: {
      division: DIVISION_ARG,
      month: MONTH_ARG,
      line: {
        type: 'string',
        enum: ['revenue', 'cogs', 'payroll_direct', 'opex', 'payroll_expense', 'all'],
        description: 'Restrict to one reporting line. Defaults to all.',
      },
      search: { type: 'string', description: 'Match against the account name or number.' },
    },
  },
  async run(input, context) {
    const { session } = context;
    const month = normaliseMonth(input.month, session.period.month);
    const division = divisionOf(input.division, context);
    const line = (input.line as string) ?? 'all';
    const search = typeof input.search === 'string' ? input.search.toLowerCase() : null;

    const divisions = division === CONSOLIDATED_CODE ? session.visibleDivisions : [division];
    const rows: Array<{
      accountId: string;
      accountName: string;
      reportingLine: string | null;
      division: string;
      amount: number;
    }> = [];

    for (const code of divisions) {
      for (const detail of session.bundle.gl.get(key(month, code)) ?? []) {
        if (line !== 'all' && detail.reportingLine !== line) continue;
        if (
          search &&
          !detail.accountName.toLowerCase().includes(search) &&
          !detail.accountId.toLowerCase().includes(search)
        ) {
          continue;
        }
        rows.push({
          accountId: detail.accountId,
          accountName: detail.accountName,
          reportingLine: detail.reportingLine,
          division: code,
          amount: detail.amount.toNumber(),
        });
      }
    }

    if (rows.length === 0) {
      return {
        result: {
          available: false,
          explanation:
            `No account-level detail is loaded for ${division} in ${formatMonth(month)}` +
            `${line === 'all' ? '' : ` on the ${line} line`}${search ? ` matching "${search}"` : ''}. ` +
            'Say so rather than reporting zero — an empty result and no data must not read the same.',
        },
      };
    }

    rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    return {
      result: {
        division,
        period: formatMonth(month),
        line,
        accounts: rows.slice(0, 50),
        truncated: rows.length > 50 ? rows.length - 50 : 0,
        note:
          'Account balances as loaded from QuickBooks, largest first. payroll_direct accounts are ' +
          'already inside COGS and payroll_expense inside OpEx — they are memo lines, so do not ' +
          'add them to their parent or subtract them from it.',
      },
      activity: `Listed ${rows.length} GL account${rows.length === 1 ? '' : 's'} · ${division} · ${formatMonth(month)}`,
    };
  },
};

const readSheetRange: ToolDefinition = {
  name: 'read_sheet_range',
  description:
    "Read a range from ARG's connected Google Sheet, live. Use this when the user asks what a sheet says — budget assumptions, headcount, anything hand-maintained. Returns the cells as they are, which is source data and not a system figure.",
  input_schema: {
    type: 'object',
    required: ['range'],
    properties: {
      range: {
        type: 'string',
        description:
          "A1 notation including the tab, e.g. 'Monthly Budget!A1:M40'. Ask the user which tab if you do not know; do not guess a tab name.",
      },
    },
  },
  async run(input, context) {
    if (!can(context.user, 'RUN_INGESTION')) {
      return {
        result: {
          permitted: false,
          explanation: 'This user is not permitted to read source systems directly.',
        },
      };
    }

    const { sheetsConnector } = await import('@/lib/connectors');
    if (!(await sheetsConnector.isConfigured())) {
      return {
        result: {
          available: false,
          explanation:
            'Google Sheets is not connected, so there is nothing to read. Say so — do not guess ' +
            'at what the sheet might contain.',
        },
      };
    }

    const range = String(input.range);

    try {
      const { readRange } = await import('@/lib/connectors/sheets');
      const { loadCredential } = await import('@/lib/connectors/credentials');
      const spreadsheetId = (await loadCredential('SHEETS'))?.data.spreadsheetId;
      if (!spreadsheetId) {
        return { result: { available: false, explanation: 'No spreadsheet is configured.' } };
      }

      const values = await readRange(spreadsheetId, range);

      return {
        result: {
          range,
          rows: values.length,
          // Bounded because a wide range would otherwise fill the context with
          // a spreadsheet and leave no room for the answer.
          values: values.slice(0, 60),
          truncated: values.length > 60 ? values.length - 60 : 0,
          note:
            'These cells are raw source data. They have not been through the conform step or the ' +
            'reconciliation controls, so quote them as "the sheet says", never as an ARG figure. ' +
            'Where a metric exists for the same thing, the metric is the system of record.',
        },
        activity: `Read ${range} from Google Sheets`,
      };
    } catch (error) {
      return {
        result: {
          available: false,
          explanation: `Google Sheets refused that read: ${error instanceof Error ? error.message : 'unknown error'}. Nothing was changed.`,
        },
      };
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

export const AGENT_TOOLS: ToolDefinition[] = [
  listKpis,
  getKpi,
  comparePeriods,
  getPlStatement,
  getVarianceDrivers,
  getPeriodState,
  getReconStatus,
  makeChart,
  queryDeals,
  queryGlAccounts,
  readSheetRange,
  listSources,
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
 * runs only after a human clicked confirm. The work itself is `runSync` — the
 * same function the Sync button in Admin and the overnight refresh call — so an
 * agent-initiated pull and an operator-initiated pull cannot diverge in what
 * they conform, what they skip, or which controls they run afterwards.
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

  const result = await runSync(db, {
    sourceSystem: run.sourceSystem as SourceSystemCode,
    entity: run.entity,
    window: { start: run.windowStart!, end: run.windowEnd! },
    requestedByUserId: user.id,
    agentConversationId: run.agentConversationId,
    existingLoadRunId: loadRunId,
  });

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'AGENT_EXTRACTION_CONFIRMED',
    entity: 'load_run',
    entityId: loadRunId,
    detail: {
      source: run.sourceSystem,
      entity: run.entity,
      ok: result.ok,
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
    },
  });

  if (!result.ok) {
    return { ok: false, message: result.error ?? 'The pull failed and nothing was written.' };
  }

  // What actually changed, in the order somebody would want to hear it. A bare
  // "succeeded" invites the reader to assume a dashboard moved, and on a load
  // that was entirely closed months, none did.
  const parts = [
    `Pulled ${result.rowsRead} record${result.rowsRead === 1 ? '' : 's'} from ${connector.label} ` +
      `and wrote ${result.rowsWritten} row${result.rowsWritten === 1 ? '' : 's'}` +
      (result.tables.length > 0 ? ` to ${result.tables.join(', ')}` : ''),
  ];
  if (result.skippedClosedMonths.length > 0) {
    parts.push(
      `${result.skippedClosedMonths.length} closed month${result.skippedClosedMonths.length === 1 ? ' was' : 's were'} left untouched`,
    );
  }
  if (result.recon) {
    parts.push(
      result.recon.failed === 0
        ? `all ${result.recon.passed} reconciliation controls passed`
        : `${result.recon.failed} reconciliation control${result.recon.failed === 1 ? '' : 's'} FAILED — say so and do not present these figures as clean`,
    );
  }
  for (const warning of result.warnings) parts.push(warning);

  return { ok: true, message: `${parts.join('. ')}.` };
}

export { sumPl };
