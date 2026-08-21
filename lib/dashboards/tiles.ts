import 'server-only';
import { resolveKpi } from '@/lib/semantic/resolve';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import type { BoxScope } from './context';

/**
 * One tile, resolved at its own scope.
 *
 * Every dashboard builds its tiles through here, so a tile pointed at another
 * division or another month gets its prior-month, prior-year and twelve-month
 * sparkline from that scope too. A tile showing February's cash beside January's
 * change would be worse than no per-box filter at all.
 */
export function buildKpiTile(scope: BoxScope, id: string, hint: string): KpiTileProps {
  const { session, divisionCode } = scope;
  const { period } = session;

  const current = resolveKpi(session, id, divisionCode);
  const priorMonth = resolveKpi(session, id, divisionCode, { month: period.priorMonth });
  const priorYear = resolveKpi(session, id, divisionCode, { month: period.priorYearMonth });

  const value = num(current);
  const pm = num(priorMonth);
  const py = num(priorYear);

  return {
    name: current.name,
    formatted: current.formatted,
    unavailable: current.unavailable,
    higherIsBetter: current.higherIsBetter,
    format: current.format,
    deltaPriorMonth: value !== null && pm !== null ? value - pm : null,
    deltaPriorYear: value !== null && py !== null ? value - py : null,
    sparkline: period.trailingTwelveMonths.map((month) =>
      num(resolveKpi(session, id, divisionCode, { month })),
    ),
    href: current.verifyHref,
    hint,
    box: {
      boxId: scope.boxId,
      divisionCode: scope.divisionCode,
      month: scope.month,
      divisionOverridden: scope.divisionOverridden,
      monthOverridden: scope.monthOverridden,
      overrideLabel: scope.overrideLabel,
    },
  };
}

/** Builds a whole set of tiles, one box id per metric. */
export function buildKpiTiles(
  boxScope: (boxId: string) => BoxScope,
  specs: Array<{ id: string; hint: string }>,
  prefix: string,
): KpiTileProps[] {
  return specs.map(({ id, hint }) => buildKpiTile(boxScope(`${prefix}_${id}`), id, hint));
}

function num(result: { value: { toNumber(): number } | null }): number | null {
  return result.value ? result.value.toNumber() : null;
}
