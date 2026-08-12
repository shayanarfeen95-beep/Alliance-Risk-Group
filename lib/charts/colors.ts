/**
 * Series colour assignment.
 *
 * The rule that matters: **colour follows the entity, never its rank.** A
 * division owns its slot for the life of the app. Filtering LITS out of a chart
 * must not repaint TP — if it did, a reader comparing two screenshots would draw
 * a false conclusion about which division moved.
 *
 * The slot comes from dim_division.sortOrder, which is data. When ARG
 * restructures its divisions again (it has twice), the mapping follows the
 * dimension table without a code change.
 */

/** Fixed slot order, validated for CVD separation in both modes. */
export const SERIES_SLOTS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;

export const SERIES_WASH = [
  'var(--series-1-wash)',
  'var(--series-2-wash)',
  'var(--series-3-wash)',
  'var(--series-4-wash)',
] as const;

/** ARG Total is a rollup, not a division — it reads as ink, not as a hue. */
export const TOTAL_COLOR = 'var(--text-primary)';

export interface DivisionColorInput {
  divisionCode: string;
  sortOrder: number;
}

/**
 * Builds a stable code -> colour map. Pass the full division list from
 * dim_division, not the filtered subset being charted.
 */
export function buildDivisionColorMap(
  allDivisions: DivisionColorInput[],
): Record<string, string> {
  const ordered = [...allDivisions].sort((a, b) => a.sortOrder - b.sortOrder);
  const map: Record<string, string> = { ARG_TOTAL: TOTAL_COLOR };
  ordered.forEach((division, index) => {
    // Past eight entities the answer is never a generated hue — fold into
    // "Other" or facet. ARG has four divisions, so this is a guard, not a path.
    map[division.divisionCode] = SERIES_SLOTS[index % SERIES_SLOTS.length]!;
  });
  return map;
}

export function divisionWash(
  allDivisions: DivisionColorInput[],
  divisionCode: string,
): string {
  const ordered = [...allDivisions].sort((a, b) => a.sortOrder - b.sortOrder);
  const index = ordered.findIndex((d) => d.divisionCode === divisionCode);
  if (index < 0) return 'transparent';
  return SERIES_WASH[index % SERIES_WASH.length]!;
}

/**
 * Status colour for an attainment or variance reading.
 *
 * §7: "An attainment ratio above 100% is good on revenue and gross profit. It is
 * bad on COGS, OpEx and payroll — it means you spent more than planned. A
 * blanket 'green above 100%' rule will paint an overspending month green and
 * mislead ARG's CEO."
 *
 * So direction is an input, never inferred from the sign.
 */
export type Sentiment = 'good' | 'bad' | 'neutral';

export function sentimentFor(delta: number, higherIsBetter: boolean): Sentiment {
  if (delta === 0) return 'neutral';
  const favourable = higherIsBetter ? delta > 0 : delta < 0;
  return favourable ? 'good' : 'bad';
}

export function sentimentColor(sentiment: Sentiment): string {
  switch (sentiment) {
    case 'good':
      return 'var(--delta-good)';
    case 'bad':
      return 'var(--delta-bad)';
    case 'neutral':
      return 'var(--text-muted)';
  }
}
