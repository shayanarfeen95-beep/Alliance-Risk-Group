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
  // forecasts, signs the monthly narrative — and delegates access.
  //
  // MANAGE_USERS was ADMIN-only, which made "super admin and delegation" from
  // the 13 August punch list impossible for the only account ARG was given.
  // Westport operates this system on ARG's behalf; the party that onboards a
  // new division manager is the party that closes the books, not a separate
  // systems administrator ARG does not employ.
  //
  // The last-administrator backstop in the users route stops the obvious way
  // this bites: a CFO can now demote an ADMIN, and without that check could
  // demote the last one and leave nobody able to administer the system.
  CFO: [
    'VIEW_CONSOLIDATED',
    'RUN_INGESTION',
    'CLOSE_PERIOD',
    'LOCK_FORECAST',
    'WAIVE_FORECAST_LOCK',
    'EDIT_MAPPINGS',
    'MANAGE_USERS',
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
 * The capability table, published for the Admin screen.
 *
 * An administrator deciding whether to make somebody a CFO or an Executive is
 * making a security decision, and "CFO" is not a description of what that
 * grants. The matrix on screen is generated from the same constant the
 * enforcement reads, so it cannot drift into describing permissions the system
 * does not actually apply — which is the failure mode of every permissions page
 * that is written by hand.
 */
export const CAPABILITY_LABELS: Record<Capability, { label: string; detail: string }> = {
  VIEW_CONSOLIDATED: {
    label: 'See ARG Total',
    detail: 'Open the consolidated rollup and every division beneath it.',
  },
  RUN_INGESTION: {
    label: 'Pull from sources',
    detail: 'Connect QuickBooks, HubSpot and Sheets, and run a sync.',
  },
  CLOSE_PERIOD: {
    label: 'Close a month',
    detail: 'Freeze a month so no refresh can restate it.',
  },
  LOCK_FORECAST: {
    label: 'Lock a forecast',
    detail: 'Commit a forecast version. A database trigger makes it immutable.',
  },
  WAIVE_FORECAST_LOCK: {
    label: 'Waive a forecast lock',
    detail: 'Record a reason for superseding a locked version. Never edits it.',
  },
  EDIT_MAPPINGS: {
    label: 'Edit mappings',
    detail: 'Map QuickBooks classes to divisions and accounts to reporting lines.',
  },
  MANAGE_USERS: {
    label: 'Manage people',
    detail: 'Add members, set roles, grant division access, end sessions.',
  },
  SIGN_COMMENTARY: {
    label: 'Sign the close narrative',
    detail: 'Approve the monthly commentary that goes to ARG leadership.',
  },
};

export const ROLE_ORDER: SessionUser['role'][] = [
  'ADMIN',
  'CFO',
  'EXECUTIVE',
  'DIVISION_MANAGER',
  'VIEWER',
];

export function capabilitiesOf(role: SessionUser['role']): Capability[] {
  return CAPABILITIES[role];
}

/** Rows for the Admin capability matrix: one per capability, one column per role. */
export function capabilityMatrix(): Array<{
  capability: Capability;
  label: string;
  detail: string;
  roles: Record<string, boolean>;
}> {
  return (Object.keys(CAPABILITY_LABELS) as Capability[]).map((capability) => ({
    capability,
    ...CAPABILITY_LABELS[capability],
    roles: Object.fromEntries(
      ROLE_ORDER.map((role) => [role, CAPABILITIES[role].includes(capability)]),
    ),
  }));
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
