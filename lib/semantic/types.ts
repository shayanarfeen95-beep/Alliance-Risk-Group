/**
 * Semantic-layer contracts.
 *
 * §1 Layer 3: "All 24 KPIs defined exactly once, as reusable calculations.
 * Dashboards and the AI assistant both read from here — never from raw tables.
 * This is what keeps the numbers consistent."
 */
import type Decimal from 'decimal.js';
import type { ValueFormat } from '@/lib/money';
import type { MonthKey, PeriodContext } from './periods';
import type { FactBundle } from './facts';

export type KpiCategory = 'finance' | 'sales' | 'marketing' | 'operations' | 'base';

/**
 * Why a figure could not be produced.
 *
 * §11 Requirement 3: "If the data does not support an answer — the month is not
 * closed, the metric is not defined, the source is unmapped — the assistant says
 * so. It never approximates a financial figure."
 *
 * This is a typed result rather than null, so nothing downstream can mistake
 * "no data" for "zero". That distinction is Defect 1 in one sentence.
 */
export type UnavailableReason =
  | 'NO_DATA' // the period or division has no rows
  | 'PENDING_DEFINITION' // a Westport decision is outstanding (§14.3)
  | 'NOT_AVAILABLE_BY_DIVISION' // ARG-Total-only in Phase 1 (Defect 2)
  | 'DEFERRED_TO_PHASE_2' // depends on an operational system that is out of scope
  | 'SOURCE_NOT_CONNECTED'; // the connector has no credentials

export interface Unavailable {
  reason: UnavailableReason;
  /** Shown to the user and given to the agent verbatim. */
  detail: string;
}

/** §11 Requirement 2: every answer cites the figures behind it. */
export interface Citation {
  label: string;
  value: string;
  source: 'QBO' | 'HubSpot' | 'Budget' | 'Sheets' | 'Manual' | 'Derived';
  periodMonth?: MonthKey;
  divisionCode?: string;
}

export interface KpiComputation {
  value: Decimal | null;
  unavailable?: Unavailable;
  citations: Citation[];
  /** Optional supporting numbers a dashboard may want (e.g. the denominator). */
  components?: Record<string, Decimal>;
}

export interface KpiDefinition {
  id: string;
  name: string;
  category: KpiCategory;
  /** Plain-language definition, published in the KPI dictionary. */
  definition: string;
  /** The formula as the spec states it. Published verbatim. */
  formula: string;
  sourceSystem: string;
  format: ValueFormat;
  /**
   * §7: "Store a direction flag on every line item in the semantic layer —
   * higher_is_better: true | false — and drive all conditional formatting and
   * all AI commentary from it."
   *
   * A blanket "green above 100%" rule paints an overspending month green.
   */
  higherIsBetter: boolean;
  refreshCadence: string;
  /** Where in the spec this is defined, so the dictionary is traceable. */
  specReference: string;
  /** Notes worth carrying into the dictionary — usually a defect fix. */
  notes?: string;
  /**
   * What this metric is called in ARG's FP&A workbook, when the two differ.
   *
   * Three of the workbook's labels are wrong about what the number is — "Gross
   * Profit Run Rate %" is a year-to-date margin, not an annualised rate — and
   * this build renamed them. Renaming without recording the old name makes the
   * metric un-findable for the person who has used the spreadsheet for two
   * years and reasonably searches for the name they know. The dictionary
   * publishes both, and the search matches both.
   */
  workbookLabel?: string;
  /**
   * Computes the KPI for a set of divisions. ARG Total passes all four, so
   * ratios are computed from summed components rather than averaged — which is
   * the only correct way to consolidate a margin or a DSO.
   */
  compute(input: KpiInput): KpiComputation;
}

export interface KpiInput {
  period: PeriodContext;
  bundle: FactBundle;
  /** The divisions in scope. One entry for a division, all four for ARG Total. */
  divisions: string[];
  /** True when `divisions` is the full set — used for labelling, not arithmetic. */
  isConsolidated: boolean;
  /** Optional per-KPI options, e.g. the Cash Runway variant toggle. */
  options?: Record<string, string | number | boolean>;
}

export interface KpiResult {
  id: string;
  name: string;
  category: KpiCategory;
  value: Decimal | null;
  formatted: string;
  unavailable?: Unavailable;
  citations: Citation[];
  components?: Record<string, Decimal>;
  higherIsBetter: boolean;
  format: ValueFormat;
  /** §11 Requirement 4: an answer about an open month is labelled preliminary. */
  periodState: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  divisionCode: string;
  periodMonth: MonthKey;
  /** Deep link a human can verify the figure against (§11 Requirement 2). */
  verifyHref: string;
}
