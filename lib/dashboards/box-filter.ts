/**
 * Per-box filters.
 *
 * The global bar sets one division and one reporting month for the page. That
 * is §7's single global parameter and it stays — but it is not enough on its
 * own. Reading a dashboard means comparing: this tile for LITS against that one
 * for SHRC, this month's cash against last month's. Doing that today means
 * changing the page filter, losing everything else on screen, and holding the
 * first number in your head.
 *
 * So every box on every dashboard carries its own filter. A box with no
 * override reads the page filter and says nothing about it; a box with one says
 * exactly what it is scoped to, on its face, and clears in one click. The state
 * lives in the URL, so a page with four boxes pointed at four divisions is a
 * link somebody can send.
 *
 * Encoding is one query parameter per overridden box — `bx_cash_position=LITS~2026-02`
 * — with an empty segment meaning "inherit from the page". Boxes without an
 * override contribute nothing to the URL, so the common case stays clean.
 */
import type { MonthKey } from '@/lib/semantic/periods';

export const BOX_PARAM_PREFIX = 'bx_';

export interface BoxOverride {
  divisionCode?: string;
  month?: MonthKey;
}

/** Box ids become query parameter names, so they are restricted at the source. */
export function boxParamName(boxId: string): string {
  return `${BOX_PARAM_PREFIX}${boxId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function encodeBoxOverride(override: BoxOverride): string {
  const division = override.divisionCode ?? '';
  const month = override.month ? override.month.slice(0, 7) : '';
  return `${division}~${month}`;
}

/** Accepts '2026-03' or '2026-03-01'. */
function normaliseMonth(value: string | undefined): MonthKey | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

export function decodeBoxOverride(raw: string | undefined): BoxOverride {
  if (!raw) return {};
  const [division = '', month = ''] = raw.split('~');
  const parsedMonth = normaliseMonth(month.trim() || undefined);
  return {
    ...(division.trim() ? { divisionCode: division.trim() } : {}),
    ...(parsedMonth ? { month: parsedMonth } : {}),
  };
}

export function isEmptyOverride(override: BoxOverride): boolean {
  return !override.divisionCode && !override.month;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Every box override present in the URL, keyed by box id.
 *
 * Unvalidated at this stage — entitlement and month-existence checks happen in
 * `loadDashboardContext`, where the user and the warehouse are both in hand. A
 * hand-edited URL naming a division the reader cannot see is dropped there, not
 * here, so there is exactly one place that decides what a reader may look at.
 */
export function readBoxOverrides(searchParams: RawSearchParams): Map<string, BoxOverride> {
  const overrides = new Map<string, BoxOverride>();

  for (const [key, value] of Object.entries(searchParams)) {
    if (!key.startsWith(BOX_PARAM_PREFIX)) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const override = decodeBoxOverride(raw);
    if (isEmptyOverride(override)) continue;
    overrides.set(key.slice(BOX_PARAM_PREFIX.length), override);
  }

  return overrides;
}

/**
 * A cap on how many distinct months one page may open.
 *
 * Each override month outside the page's own window costs a second fact bundle.
 * Six is far more than a person will set by hand and cheap enough to serve; a
 * URL asking for forty is refused the extras rather than being served slowly.
 */
export const MAX_OVERRIDE_MONTHS = 6;

/**
 * What the per-box filter control offers.
 *
 * Lives here rather than beside the dashboard context so the client control can
 * import the type without pulling a `server-only` module into the browser
 * bundle.
 */
export interface BoxFilterOptions {
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  months: MonthKey[];
  consolidatedAvailable: boolean;
  pageDivisionCode: string;
  pageDivisionLabel: string;
  pageMonth: MonthKey;
}

/**
 * A box's filter state, as the control needs it.
 *
 * The resolved scope minus the semantic session — everything that is safe to
 * hand to a client component.
 */
export interface BoxFilterState {
  boxId: string;
  divisionCode: string;
  month: MonthKey;
  divisionOverridden: boolean;
  monthOverridden: boolean;
  /** What the chip says, or null when the box follows the page. */
  overrideLabel: string | null;
}

/** Which fields a box's filter offers. A table of all divisions omits division. */
export type BoxFilterField = 'division' | 'month';
