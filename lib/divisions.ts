/**
 * §3 — The Division Model.
 *
 * "Four divisions plus a consolidated parent. This mapping is non-negotiable —
 * the entire FP&A model is built on it."
 *
 * This file is the *seed* for dim_division, not a runtime lookup. Application
 * code reads the dimension table (§2 Rule 8: "Divisions live in a dimension
 * table. ARG has restructured its divisions twice already. Assume it happens
 * again."). Changing a division at runtime is a data edit, not a deploy.
 *
 * Legacy codes are carried as aliases so historical data and older exports map
 * cleanly. This is the fix for Defect 1: the balance-sheet tab still stores the
 * old six codes while the KPI tab looks up the new four, and because every
 * formula is wrapped in IFERROR(...,0) the mismatch returns zero instead of an
 * error — silently killing four of ARG's eight finance KPIs at division level.
 */

export interface DivisionSeed {
  divisionCode: string;
  divisionName: string;
  lineOfBusiness: string;
  legacyCodes: string[];
  qboClassIds: string[];
  primaryOperationalSystem: string | null;
  sortOrder: number;
}

export const DIVISION_SEED: DivisionSeed[] = [
  {
    divisionCode: 'SHRC',
    divisionName: 'SHRC',
    lineOfBusiness: 'Background screening / HR services',
    legacyCodes: ['BGI'],
    qboClassIds: ['CLASS_SHRC'],
    primaryOperationalSystem: 'Tazworks, iSolved',
    sortOrder: 1,
  },
  {
    divisionCode: 'CLAIMS',
    divisionName: 'Claims',
    lineOfBusiness: 'Claims adjusting and investigation',
    legacyCodes: ['CA', 'INV'],
    qboClassIds: ['CLASS_CLAIMS'],
    // §14.3 open item 3: the one operational system not yet identified.
    primaryOperationalSystem: null,
    sortOrder: 2,
  },
  {
    divisionCode: 'TP',
    divisionName: 'TP',
    lineOfBusiness: 'Process service — third-party serves',
    legacyCodes: ['PS - TP'],
    qboClassIds: ['CLASS_TP'],
    primaryOperationalSystem: 'TrackOps',
    sortOrder: 3,
  },
  {
    divisionCode: 'LITS',
    divisionName: 'LITS',
    lineOfBusiness: 'Litigation support services',
    legacyCodes: ['PS - APS', 'PS - Other'],
    qboClassIds: ['CLASS_LITS'],
    primaryOperationalSystem: 'ServeManager',
    sortOrder: 4,
  },
];

/**
 * §3: "ARG Total is a rollup, never a row. Do not store an 'ARG Total' record in
 * the fact tables. Compute it as the sum of the four divisions so it can never
 * drift from its parts."
 *
 * The Excel stores it as a row, which is exactly why it can drift. Enforced by a
 * CHECK constraint on every fact table.
 */
export const CONSOLIDATED = {
  divisionCode: 'ARG_TOTAL',
  divisionName: 'ARG Total',
  lineOfBusiness: 'Consolidated parent — sum of the four divisions',
} as const;

/**
 * Resolves a legacy or current code to a current division code.
 *
 * §3: "The old 'Process Service' unit is now two divisions. Wherever older ARG
 * documentation says 'Process Service,' read it as 'TP + LITS.'" There is no
 * single answer for a bare "Process Service" code, so it is deliberately absent
 * from the alias map — a load carrying it fails loudly and a human decides,
 * rather than the system silently picking one.
 */
export function buildAliasMap(divisions: DivisionSeed[] = DIVISION_SEED): Map<string, string> {
  const map = new Map<string, string>();
  for (const division of divisions) {
    map.set(normaliseCode(division.divisionCode), division.divisionCode);
    for (const legacy of division.legacyCodes) {
      map.set(normaliseCode(legacy), division.divisionCode);
    }
    for (const classId of division.qboClassIds) {
      map.set(normaliseCode(classId), division.divisionCode);
    }
  }
  return map;
}

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, ' ');
}

export class UnmappedDivisionError extends Error {
  constructor(public readonly rawCode: string) {
    super(
      `Division code "${rawCode}" is not mapped to any current division. ` +
        `Add it to dim_division.legacy_codes or dim_division.qbo_class_ids. ` +
        `Loads never default to "other" — see Defect 1 and Acceptance Test 8.`,
    );
    this.name = 'UnmappedDivisionError';
  }
}

/** Throws rather than returning a fallback. That is the entire point. */
export function resolveDivision(rawCode: string, aliases: Map<string, string>): string {
  const resolved = aliases.get(normaliseCode(rawCode));
  if (!resolved) throw new UnmappedDivisionError(rawCode);
  return resolved;
}
