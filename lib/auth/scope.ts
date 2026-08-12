/**
 * Division entitlements.
 *
 * Enforcement lives here, in the data path — not in the UI. Every query, every
 * export and every agent tool call resolves its division list through this
 * module, so a Division Manager cannot reach another division's numbers by
 * editing a URL parameter or by asking the agent nicely.
 */
import type { SessionUser } from './session';

export type Capability =
  | 'VIEW_CONSOLIDATED'
  | 'RUN_INGESTION'
  | 'CLOSE_PERIOD'
  | 'LOCK_FORECAST'
  | 'WAIVE_FORECAST_LOCK'
  | 'EDIT_MAPPINGS'
  | 'MANAGE_USERS'
  | 'SIGN_COMMENTARY';

const CAPABILITIES: Record<SessionUser['role'], Capability[]> = {
  ADMIN: [
    'VIEW_CONSOLIDATED',
    'RUN_INGESTION',
    'CLOSE_PERIOD',
    'LOCK_FORECAST',
    'WAIVE_FORECAST_LOCK',
    'EDIT_MAPPINGS',
    'MANAGE_USERS',
    'SIGN_COMMENTARY',
  ],
  // Westport is ARG's fractional CFO of record: closes the books, locks
  // forecasts, signs the monthly narrative.
  CFO: [
    'VIEW_CONSOLIDATED',
    'RUN_INGESTION',
    'CLOSE_PERIOD',
    'LOCK_FORECAST',
    'WAIVE_FORECAST_LOCK',
    'EDIT_MAPPINGS',
    'SIGN_COMMENTARY',
  ],
  EXECUTIVE: ['VIEW_CONSOLIDATED'],
  DIVISION_MANAGER: ['LOCK_FORECAST'],
  VIEWER: [],
};

export function can(user: SessionUser, capability: Capability): boolean {
  return CAPABILITIES[user.role].includes(capability);
}

/**
 * The division codes a user may see, intersected with what they asked for.
 *
 * `allDivisions` comes from dim_division — never a hardcoded list (§2 Rule 8).
 */
export function scopeDivisions(
  user: SessionUser,
  allDivisions: string[],
  requested?: string[],
): string[] {
  const permitted = user.canViewConsolidated ? allDivisions : user.divisionCodes;
  const visible = allDivisions.filter((code) => permitted.includes(code));
  if (!requested || requested.length === 0) return visible;
  return visible.filter((code) => requested.includes(code));
}

/**
 * May this user see ARG Total? Only if they can see every division — otherwise
 * the consolidated figure would leak the divisions they are not entitled to.
 */
export function canSeeConsolidated(user: SessionUser, allDivisions: string[]): boolean {
  if (user.canViewConsolidated) return true;
  return allDivisions.every((code) => user.divisionCodes.includes(code));
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** Throws when a request reaches past the user's entitlements. */
export function assertDivisionAccess(
  user: SessionUser,
  allDivisions: string[],
  requested: string,
): void {
  if (requested === 'ARG_TOTAL') {
    if (!canSeeConsolidated(user, allDivisions)) {
      throw new ScopeError('Not entitled to the consolidated view.');
    }
    return;
  }
  const permitted = scopeDivisions(user, allDivisions);
  if (!permitted.includes(requested)) {
    throw new ScopeError(`Not entitled to division ${requested}.`);
  }
}
