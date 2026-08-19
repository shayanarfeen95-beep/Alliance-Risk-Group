import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';

/**
 * How a HubSpot deal becomes an ARG division.
 *
 * Open item 2, and the one the build documentation calls the most likely to be
 * answered with a plausible-sounding rule that is wrong a quarter of the time.
 * A deal attributed to the wrong division moves revenue between two divisional
 * P&Ls and is invisible at ARG Total, which is how that class of error survives
 * a year.
 *
 * So the rule is data, not code, and it has three parts:
 *
 *   1. **Which field carries it** — a deal property, the pipeline, or the deal
 *      owner. Or `none`, which is a real answer: sales and marketing report at
 *      ARG Total only.
 *   2. **What each of that field's values means.** HubSpot holds
 *      "Litigation Support", ARG's warehouse holds `LITS`. Nothing can infer
 *      that mapping safely, so somebody at Westport states it once, here.
 *   3. **What happens to a value nobody has mapped.** It stays unattributed —
 *      counted, reported, and visible on the mapping screen. It is never
 *      guessed into a division and never quietly dropped.
 */

export type AttributionRule = 'deal_property' | 'pipeline' | 'owner' | 'none';

export const ATTRIBUTION_KEY = 'HUBSPOT_DIVISION_ATTRIBUTION';
export const PROPERTY_KEY = 'HUBSPOT_DIVISION_PROPERTY';
export const VALUE_MAP_KEY = 'HUBSPOT_DIVISION_MAP';

export const ATTRIBUTION_RULES: Array<{ id: AttributionRule; label: string; hint: string }> = [
  {
    id: 'deal_property',
    label: 'A deal property',
    hint: 'A custom property on the deal, e.g. "division" or "line_of_business".',
  },
  {
    id: 'pipeline',
    label: 'The pipeline',
    hint: 'Each ARG division runs its own HubSpot pipeline.',
  },
  {
    id: 'owner',
    label: 'The deal owner',
    hint: 'Each salesperson sells for exactly one division. Fragile if anyone crosses over.',
  },
  {
    id: 'none',
    label: 'No reliable rule',
    hint: 'Sales and marketing metrics report at ARG Total only. A real answer, not a failure.',
  },
];

export interface HubspotMapping {
  rule: AttributionRule;
  /** Westport has signed the rule off. Until then divisional metrics withhold. */
  isConfirmed: boolean;
  /** The deal property carrying the division, when the rule is deal_property. */
  property: string | null;
  /** Source value (lower-cased) → ARG division code. */
  values: Record<string, string>;
}

function parseValueMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key.toLowerCase()] = value;
    }
    return out;
  } catch {
    // A corrupt map attributes nothing rather than attributing wrongly.
    return {};
  }
}

export async function loadHubspotMapping(db: Database): Promise<HubspotMapping> {
  const rows = await db
    .select()
    .from(t.appConfig)
    .where(sql`${t.appConfig.key} in (${ATTRIBUTION_KEY}, ${PROPERTY_KEY}, ${VALUE_MAP_KEY})`);

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const attribution = byKey.get(ATTRIBUTION_KEY);
  const rule = (attribution?.value ?? 'none') as AttributionRule;

  return {
    rule: ATTRIBUTION_RULES.some((candidate) => candidate.id === rule) ? rule : 'none',
    isConfirmed: attribution?.isConfirmed ?? false,
    property: byKey.get(PROPERTY_KEY)?.value?.trim() || null,
    values: parseValueMap(byKey.get(VALUE_MAP_KEY)?.value),
  };
}

/** The raw HubSpot value this deal is attributed by, before any mapping. */
export function attributionValueOf(
  mapping: HubspotMapping,
  payload: HubspotDealPayload,
): string | null {
  const properties = payload.properties ?? {};

  switch (mapping.rule) {
    case 'deal_property': {
      if (!mapping.property) return null;
      const value = properties[mapping.property];
      return value ? String(value) : null;
    }
    case 'pipeline':
      return properties.pipeline ? String(properties.pipeline) : null;
    case 'owner':
      return properties.hubspot_owner_id ? String(properties.hubspot_owner_id) : null;
    case 'none':
      return null;
  }
}

/**
 * The division for one deal, or null.
 *
 * Two ways a value resolves, and no third: somebody mapped it, or it is exactly
 * an ARG division code. Everything else is unattributed. "Close enough" matching
 * — a prefix, a fuzzy name, a default of "other" — is precisely the invented
 * rule the specification refuses.
 */
export function divisionForDeal(
  mapping: HubspotMapping,
  payload: HubspotDealPayload,
  activeDivisions: string[],
): string | null {
  const raw = attributionValueOf(mapping, payload);
  if (!raw) return null;

  const mapped = mapping.values[raw.toLowerCase()];
  if (mapped && activeDivisions.includes(mapped)) return mapped;

  const exact = activeDivisions.find((code) => code.toLowerCase() === raw.toLowerCase());
  return exact ?? null;
}

export interface HubspotDealPayload {
  id?: string;
  properties?: Record<string, unknown>;
  propertiesWithHistory?: Record<string, Array<{ value?: string; timestamp?: string }>>;
  associations?: Record<string, { results?: Array<{ id?: string; type?: string }> }>;
}

export interface ObservedValue {
  /** The value as HubSpot holds it. */
  value: string;
  /** How many landed deals carry it. */
  deals: number;
  /** The division it currently maps to, or null. */
  mappedTo: string | null;
}

/**
 * What the landed HubSpot data actually contains, for the field being mapped.
 *
 * This is the mapping screen's whole point: somebody at Westport should be
 * choosing from the values HubSpot really holds, with the deal counts beside
 * them, rather than typing what they believe those values to be.
 */
export async function observedAttributionValues(
  db: Database,
  mapping: HubspotMapping,
  activeDivisions: string[],
): Promise<{ values: ObservedValue[]; sampledDeals: number; lastLandedAt: string | null }> {
  const rows = await db
    .select({ payload: t.rawPayload.payload, fetchedAt: t.rawPayload.fetchedAt })
    .from(t.rawPayload)
    .where(and(eq(t.rawPayload.sourceSystem, 'HUBSPOT'), eq(t.rawPayload.entity, 'deals')))
    .orderBy(desc(t.rawPayload.fetchedAt))
    .limit(5000);

  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = attributionValueOf(mapping, row.payload as HubspotDealPayload);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const values: ObservedValue[] = [...counts.entries()]
    .map(([value, deals]) => {
      const mapped = mapping.values[value.toLowerCase()];
      const exact = activeDivisions.find((code) => code.toLowerCase() === value.toLowerCase());
      return {
        value,
        deals,
        mappedTo: (mapped && activeDivisions.includes(mapped) ? mapped : null) ?? exact ?? null,
      };
    })
    .sort((a, b) => b.deals - a.deals);

  return {
    values,
    sampledDeals: rows.length,
    lastLandedAt: rows[0]?.fetchedAt?.toISOString() ?? null,
  };
}

export interface MappingUpdate {
  rule: AttributionRule;
  property?: string | null;
  values?: Record<string, string>;
  /** Westport signing the rule off. Divisional metrics stay withheld until true. */
  isConfirmed?: boolean;
}

/**
 * Writes the mapping, and records who changed it.
 *
 * The audit event matters more here than almost anywhere else in the system: a
 * changed attribution rule silently restates every divisional sales figure in
 * every prior month, and the first question afterwards is always "when did this
 * change, and who changed it?"
 */
export async function saveHubspotMapping(
  db: Database,
  user: SessionUser,
  update: MappingUpdate,
): Promise<HubspotMapping> {
  const before = await loadHubspotMapping(db);

  const rows: Array<{ key: string; value: string; isConfirmed: boolean; description: string }> = [
    {
      key: ATTRIBUTION_KEY,
      value: update.rule,
      isConfirmed: update.isConfirmed ?? before.isConfirmed,
      description:
        'Open item 2 — how a HubSpot deal is attributed to a division: deal_property | pipeline | owner | none. Set from Admin → HubSpot division mapping. Setting this to "none" reports sales and marketing KPIs at ARG Total only rather than inventing an attribution rule.',
    },
    {
      key: PROPERTY_KEY,
      value: (update.property ?? before.property ?? '').trim(),
      isConfirmed: true,
      description:
        'The HubSpot deal property carrying the division, when the attribution rule is deal_property. Also added to the properties requested from the HubSpot API.',
    },
    {
      key: VALUE_MAP_KEY,
      value: JSON.stringify(
        Object.fromEntries(
          Object.entries(update.values ?? before.values)
            .filter(([, division]) => Boolean(division))
            .map(([value, division]) => [value.toLowerCase(), division]),
        ),
      ),
      isConfirmed: true,
      description:
        'HubSpot source value → ARG division code. A value with no entry here is left unattributed and counted, never guessed into a division.',
    },
  ];

  for (const row of rows) {
    await db
      .insert(t.appConfig)
      .values({ ...row, updatedBy: user.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: t.appConfig.key,
        set: {
          value: row.value,
          isConfirmed: row.isConfirmed,
          description: row.description,
          updatedBy: user.id,
          updatedAt: new Date(),
        },
      });
  }

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'HUBSPOT_MAPPING_UPDATED',
    entity: 'app_config',
    entityId: ATTRIBUTION_KEY,
    detail: {
      before: { rule: before.rule, property: before.property, values: before.values },
      after: {
        rule: update.rule,
        property: update.property ?? before.property,
        values: update.values ?? before.values,
      },
    },
  });

  return loadHubspotMapping(db);
}
