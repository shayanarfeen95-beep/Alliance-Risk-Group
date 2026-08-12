/**
 * The single entry point to every number in this system.
 *
 * §1: "If a KPI is coded inside a dashboard widget, the AI assistant will
 * eventually compute it a second, slightly different way — and ARG's CEO will
 * see two numbers for the same metric in the same week. Define each KPI once, in
 * the semantic layer, and have everything read from it. This is the single most
 * important architectural decision in this build."
 *
 * Dashboards, exports, the audit pack and every agent tool call go through
 * `resolveKpi`. There is no other path. The agent has no raw-SQL tool, so it is
 * structurally incapable of disagreeing with a dashboard.
 */
import { formatValue } from '@/lib/money';
import { canSeeConsolidated, scopeDivisions, ScopeError } from '@/lib/auth/scope';
import type { SessionUser } from '@/lib/auth/session';
import type { Database } from '@/lib/db/client';
import { loadFactBundle, type FactBundle } from './facts';
import { buildPeriodContext, type MonthKey, type PeriodContext } from './periods';
import { getKpiDefinition, KPI_REGISTRY } from './registry';
import type { KpiResult } from './types';

export const CONSOLIDATED_CODE = 'ARG_TOTAL';

export interface SemanticSession {
  period: PeriodContext;
  bundle: FactBundle;
  user: SessionUser;
  /** Division codes the user may see, in display order. */
  visibleDivisions: string[];
  /** Whether the consolidated rollup is available to this user. */
  consolidatedAvailable: boolean;
  /** §5.3 / §9 — shown on the face of every view. */
  periodIsClosed: boolean;
  lastRefreshedAt: Date | null;
  accountingBasis: string;
}

/**
 * Loads everything needed to answer questions about one reporting month, once.
 *
 * Entitlements are applied at load time, so a KPI cannot reach a division the
 * user is not entitled to — the rows were never fetched.
 */
export async function openSemanticSession(
  db: Database,
  user: SessionUser,
  month: MonthKey,
): Promise<SemanticSession> {
  const period = buildPeriodContext(month);

  // The dimension is read first so entitlements are computed against real data
  // rather than a hardcoded division list (§2 Rule 8). The bundle then loads
  // only the divisions this user may see.
  const allDivisions = await listActiveDivisions(db);
  const visible = scopeDivisions(user, allDivisions);
  const bundle = await loadFactBundle(db, period, visible);

  return {
    period,
    bundle,
    user,
    visibleDivisions: bundle.divisions.map((d) => d.divisionCode),
    consolidatedAvailable: canSeeConsolidated(user, allDivisions),
    periodIsClosed: bundle.periodState.get(month)?.isClosed ?? false,
    lastRefreshedAt: bundle.lastRefreshedAt,
    accountingBasis: bundle.config.get('ACCOUNTING_BASIS')?.value ?? 'accrual',
  };
}

async function listActiveDivisions(db: Database): Promise<string[]> {
  const { dimDivision } = await import('@/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select({ divisionCode: dimDivision.divisionCode })
    .from(dimDivision)
    .where(eq(dimDivision.isActive, true))
    .orderBy(dimDivision.sortOrder);
  return rows.map((row) => row.divisionCode);
}

export interface ResolveOptions {
  /** Overrides the session's reporting month for this one call. */
  month?: MonthKey;
  /** Per-KPI options, e.g. { variant: 'trailing_3m' } or { scenario: 'TENX' }. */
  options?: Record<string, string | number | boolean>;
}

/**
 * Resolves one KPI for one division (or ARG Total).
 *
 * ARG Total is computed as the sum of the four divisions — never read from a
 * stored row (§3). Because each KPI receives the division LIST and sums the
 * underlying components itself, ratios consolidate correctly: ARG Total gross
 * margin is total gross profit over total revenue, not an average of four
 * margins.
 */
export function resolveKpi(
  session: SemanticSession,
  id: string,
  divisionCode: string,
  resolveOptions: ResolveOptions = {},
): KpiResult {
  const definition = getKpiDefinition(id);
  if (!definition) {
    throw new Error(
      `Unknown KPI "${id}". Every metric must be defined in the semantic-layer registry; nothing computes ad hoc.`,
    );
  }

  const isConsolidated = divisionCode === CONSOLIDATED_CODE;

  if (isConsolidated && !session.consolidatedAvailable) {
    throw new ScopeError(
      'Not entitled to the consolidated view. ARG Total would disclose divisions this user cannot see.',
    );
  }
  if (!isConsolidated && !session.visibleDivisions.includes(divisionCode)) {
    throw new ScopeError(`Not entitled to division ${divisionCode}.`);
  }

  const divisions = isConsolidated ? session.visibleDivisions : [divisionCode];
  const period = resolveOptions.month
    ? buildPeriodContext(resolveOptions.month)
    : session.period;

  const computation = definition.compute({
    period,
    bundle: session.bundle,
    divisions,
    isConsolidated,
    options: resolveOptions.options,
  });

  const periodState = session.bundle.periodState.get(period.month);

  return {
    id: definition.id,
    name: definition.name,
    category: definition.category,
    value: computation.value,
    formatted: computation.value === null ? '—' : formatValue(computation.value, definition.format),
    unavailable: computation.unavailable,
    citations: computation.citations,
    components: computation.components,
    higherIsBetter: definition.higherIsBetter,
    format: definition.format,
    periodState: periodState ? (periodState.isClosed ? 'CLOSED' : 'OPEN') : 'UNKNOWN',
    divisionCode,
    periodMonth: period.month,
    verifyHref: buildVerifyHref(definition.category, period.month, divisionCode),
  };
}

/**
 * §11 Requirement 2: every answer "links to the dashboard view a human can
 * verify it against."
 */
function buildVerifyHref(
  category: string,
  month: MonthKey,
  divisionCode: string,
): string {
  const page =
    category === 'sales' ? 'sales' : category === 'marketing' ? 'marketing' : 'finance';
  return `/${page}?month=${month.slice(0, 7)}&division=${divisionCode}`;
}

/** Resolves a KPI across several divisions in one call — the dashboard shape. */
export function resolveKpiByDivision(
  session: SemanticSession,
  id: string,
  divisionCodes: string[],
  resolveOptions: ResolveOptions = {},
): KpiResult[] {
  return divisionCodes.map((code) => resolveKpi(session, id, code, resolveOptions));
}

/** Resolves a KPI across a series of months — the sparkline and trend shape. */
export function resolveKpiOverMonths(
  session: SemanticSession,
  id: string,
  divisionCode: string,
  months: MonthKey[],
  resolveOptions: ResolveOptions = {},
): KpiResult[] {
  return months.map((month) =>
    resolveKpi(session, id, divisionCode, { ...resolveOptions, month }),
  );
}

/** Every KPI id the registry knows about — used by the agent's tool schema. */
export function allKpiIds(): string[] {
  return KPI_REGISTRY.map((definition) => definition.id);
}
