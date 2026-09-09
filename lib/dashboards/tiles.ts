import 'server-only';
import Decimal from 'decimal.js';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { formatMonthShort, type MonthKey } from '@/lib/semantic/periods';
import { getKpiDefinition } from '@/lib/semantic/registry';
import { formatNumber } from '@/lib/format';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';

/**
 * One tile, assembled once for every dashboard.
 *
 * Five dashboards each had their own copy of "resolve the metric, resolve it
 * for the prior month and the prior year, map the trailing twelve". Identical
 * code, five places to change, and the reason the tiles had nothing behind them
 * but a number and two deltas: adding anything meant adding it five times.
 *
 * What a tile carries now is what HubSpot's report cards carry — the figure,
 * the comparisons you can switch between, the breakdown by division, and the
 * trend — all resolved through `resolveKpi`, all computed here, so opening a
 * card costs no round trip and cannot produce a figure the dashboard behind it
 * disagrees with.
 *
 * Everything is precomputed rather than fetched on expand. The whole warehouse
 * for one reporting context is already in memory — 39 months by 4 divisions is
 * 156 P&L rows — so resolving a metric five more times is free, and an
 * interaction that is instant gets used while one that spins does not.
 */

export interface TileSpec {
  id: string;
  /** Shown on hover — usually the formula or the denominator. */
  hint?: string;
  /** Link for drill-through. */
  href?: string;
}

const num = (result: { value: Decimal | null }): number | null =>
  result.value ? result.value.toNumber() : null;

export function buildTile(
  session: SemanticSession,
  spec: TileSpec,
  divisionCode: string,
): KpiTileProps {
  const { period, bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;

  const current = resolveKpi(session, spec.id, divisionCode);
  const priorMonth = resolveKpi(session, spec.id, divisionCode, { month: period.priorMonth });
  const priorYear = resolveKpi(session, spec.id, divisionCode, { month: period.priorYearMonth });

  const value = num(current);
  const pm = num(priorMonth);
  const py = num(priorYear);

  // --- Comparisons -------------------------------------------------------
  // Both bases carry their own formatted figure, not just the delta. "Down
  // $82,000" prompts "down from what?" every time, and the answer was never on
  // the card.
  const comparisons: KpiTileProps['comparisons'] = [
    {
      id: 'prior_month',
      label: 'Prior month',
      periodLabel: formatMonthShort(period.priorMonth),
      formatted: priorMonth.unavailable ? null : priorMonth.formatted,
      delta: value !== null && pm !== null ? value - pm : null,
      pctChange: value !== null && pm !== null && pm > 0 ? (value - pm) / pm : null,
    },
    {
      id: 'prior_year',
      label: 'Prior year',
      periodLabel: formatMonthShort(period.priorYearMonth),
      formatted: priorYear.unavailable ? null : priorYear.formatted,
      delta: value !== null && py !== null ? value - py : null,
      pctChange: value !== null && py !== null && py > 0 ? (value - py) / py : null,
    },
  ];

  // Budget only where a budget exists for this line. Offering the comparison on
  // Days Sales Outstanding would be a control that never resolves.
  const budgetable = ['revenue', 'cogs', 'opex'].includes(spec.id);
  if (budgetable) {
    const attainment = resolveKpi(session, 'budget_attainment', divisionCode, {
      options: { scenario: 'MONTHLY_BUDGET', lineItem: spec.id, scope: 'month' },
    });
    if (!attainment.unavailable && attainment.components?.budget) {
      const budget = attainment.components.budget.toNumber();
      comparisons.push({
        id: 'budget',
        label: 'Budget',
        periodLabel: formatMonthShort(period.month),
        formatted: attainment.components.budget.toDecimalPlaces(0).toString(),
        delta: value !== null ? value - budget : null,
        pctChange: value !== null && budget > 0 ? (value - budget) / budget : null,
      });
    }
  }

  // --- Breakdown by division ---------------------------------------------
  // The question a leader asks second, always: "which division is that?" At a
  // single division there is nothing to break down, so the control is absent
  // rather than present and empty.
  let breakdown: KpiTileProps['breakdown'];

  if (isConsolidated && session.visibleDivisions.length > 1) {
    const rows = session.visibleDivisions.map((code) => {
      const result = resolveKpi(session, spec.id, code);
      return {
        label: bundle.divisions.find((d) => d.divisionCode === code)?.divisionName ?? code,
        code,
        formatted: result.unavailable ? null : result.formatted,
        value: num(result),
      };
    });

    // A share only means something for a metric that adds up. A margin, a DSO
    // or a win rate does not: SHRC's 40% margin is not "31% of ARG's margin",
    // and a bar chart of those shares would be actively misleading.
    const definition = getKpiDefinition(spec.id);
    const additive =
      definition?.format === 'currency' ||
      definition?.format === 'currency_precise' ||
      definition?.format === 'count';

    const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);

    breakdown = {
      dimension: 'Division',
      additive,
      rows: rows.map((row) => ({
        ...row,
        share: additive && total > 0 && row.value !== null ? row.value / total : null,
      })),
    };
  }

  // --- Trend -------------------------------------------------------------
  const trend = period.trailingTwelveMonths.map((month: MonthKey) => ({
    month,
    label: formatMonthShort(month),
    value: num(resolveKpi(session, spec.id, divisionCode, { month })),
  }));

  const definition = getKpiDefinition(spec.id);

  return {
    name: current.name,
    formatted: current.formatted,
    unavailable: current.unavailable,
    higherIsBetter: current.higherIsBetter,
    format: current.format,
    deltaPriorMonth: value !== null && pm !== null ? value - pm : null,
    deltaPriorYear: value !== null && py !== null ? value - py : null,
    sparkline: trend.map((point) => point.value),
    hint: spec.hint ?? definition?.formula,
    href: spec.href,
    comparisons,
    breakdown,
    trend,
    // Published on the card so a reader can check the definition without
    // leaving the page — and so "where does this come from" has an answer that
    // is not "ask somebody".
    definition: definition
      ? {
          formula: definition.formula,
          source: definition.sourceSystem,
          workbookLabel: definition.workbookLabel ?? null,
        }
      : undefined,
    citations: current.unavailable
      ? []
      : current.citations.map((citation) => ({
          label: citation.label,
          // Citations carry a raw decimal string, which is right for the agent
          // and wrong on a card: "1410234" is not a figure a finance reader
          // parses at a glance. Formatted only where the value is actually a
          // number — "Months elapsed: 3" must stay as it is, not become "$3".
          value: formatCitation(citation.value, current.format),
          source: String(citation.source),
        })),
    periodLabel: formatMonthShort(period.month),
    isOpenPeriod: current.periodState === 'OPEN',
  };
}

/**
 * A citation value as a person reads it.
 *
 * The KPI's own format is the right one for its money citations — a currency
 * metric cites currency components. A small integer is left alone: it is a
 * count of months or of deals, and formatting it as the parent metric would
 * turn "3" into "$3".
 */
function formatCitation(raw: string, format: KpiTileProps['format']): string {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return raw;

  const magnitude = Math.abs(parsed);
  if (Number.isInteger(parsed) && magnitude < 1000) return raw;

  if (format === 'currency' || format === 'currency_precise') {
    return formatNumber(parsed, 'currency');
  }
  return formatNumber(parsed, format);
}

/** The whole row, in one call. */
export function buildTiles(
  session: SemanticSession,
  specs: TileSpec[],
  divisionCode: string,
): KpiTileProps[] {
  return specs.map((spec) => buildTile(session, spec, divisionCode));
}
