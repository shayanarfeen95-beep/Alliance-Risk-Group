/**
 * The HubSpot fields Westport's leadership review is defined on, found by label.
 *
 * Westport wrote their definitions the way HubSpot shows them: "Line of Business
 * (Deals) is any of Background Checks", "Date Compliance Review Completed is
 * This year". Those are labels. A custom property's internal name is whatever
 * HubSpot generated when somebody created it — `line_of_business`,
 * `line_of_business__c`, `lob` — and guessing it wrong fails silently: HubSpot
 * returns no value for a property it does not have, so every deal would read as
 * "no line of business" and the dashboard would quietly show nothing.
 *
 * So the field is looked up in HubSpot's own field list by its label, the way a
 * person would find it, and the internal name is only a fallback for when the
 * field list cannot be read. Option values are translated back to their labels
 * the same way, so "Background Checks" is compared with "Background Checks"
 * rather than with whatever internal value the option happens to carry.
 *
 * Shared by the connector (which fields to ask for) and the import (what the
 * answers mean), so the two cannot disagree about which field is which.
 */

export interface HubspotPropertyDefinition {
  name: string;
  label: string;
  type?: string | null;
  fieldType?: string | null;
  groupName?: string | null;
  options?: Array<{ label?: string; value?: string; hidden?: boolean }> | null;
  hidden?: boolean;
}

export type HubspotObjectType = 'deals' | 'contacts';

export interface FieldSpec {
  object: HubspotObjectType;
  /** What the field is called in HubSpot, as Westport wrote it. */
  label: string;
  /** Tried in order against the field list; the first that matches wins. */
  match: RegExp[];
  /** Internal names to ask for when the field list cannot be read. */
  fallback: string[];
}

export const LEADERSHIP_FIELDS = {
  lineOfBusiness: {
    object: 'deals',
    label: 'Line of Business',
    match: [/^\s*line of business\s*$/i, /line of business/i],
    fallback: ['line_of_business'],
  },
  complianceReviewCompleted: {
    object: 'deals',
    label: 'Date Compliance Review Completed',
    match: [/^\s*date compliance review completed\s*$/i, /compliance review (completed|complete|date)/i],
    fallback: ['date_compliance_review_completed', 'compliance_review_completed'],
  },
  contactLeadSource: {
    object: 'contacts',
    label: 'Lead Source',
    match: [/^\s*lead source\s*$/i],
    fallback: ['lead_source'],
  },
} satisfies Record<string, FieldSpec>;

export type LeadershipFieldId = keyof typeof LEADERSHIP_FIELDS;

/**
 * Standard HubSpot fields, asked for by name because every portal has them.
 *
 * "Created by" is a user id, not an owner id. "Date entered Marketing Qualified
 * Lead (Lifecycle Stage Pipeline)" is HubSpot's calculated v2 date-entered
 * field — the one Westport's own SQL report filters on.
 */
export const DEAL_CREATED_BY = 'hs_created_by_user_id';
export const CONTACT_MQL_ENTERED = 'hs_v2_date_entered_marketingqualifiedlead';

/**
 * Bumped whenever the set of fields a HubSpot object is read with changes.
 *
 * A record nobody has edited since the last pull is not returned by a "what
 * changed" read, so adding a field would leave every untouched record without
 * it. A different version makes the next pull of that object read it from the
 * beginning, once.
 */
export const HUBSPOT_FIELDS_VERSION: Partial<Record<string, string>> = {
  // Line of Business, Date Compliance Review Completed, Created by.
  deals: '2026-10-29.leadership',
  // Also every contact whose Lead Source is one of the SQL sources.
  mql_contacts: '2026-10-30.lead-source',
};

/**
 * "SQLs/month … Lead Source is any of Website, SHRM RFQ, Webinar, or Trade
 * Show/Conference" — Westport's words, matched against HubSpot's option labels.
 */
export const SQL_LEAD_SOURCES = ['Website', 'SHRM RFQ', 'Webinar', 'Trade Show/Conference'];

/** The field in this list that a spec names, or null when it is not there. */
export function findField(
  spec: FieldSpec,
  catalog: HubspotPropertyDefinition[] | null | undefined,
): HubspotPropertyDefinition | null {
  if (!catalog?.length) return null;
  for (const pattern of spec.match) {
    const hit = catalog.find((property) => pattern.test(property.label ?? ''));
    if (hit) return hit;
  }
  return null;
}

/**
 * The internal names to request for a spec.
 *
 * The matched field when the list was read; otherwise every fallback, which
 * costs nothing because HubSpot leaves out properties a portal does not have.
 */
export function namesToRequest(
  spec: FieldSpec,
  catalog: HubspotPropertyDefinition[] | null | undefined,
): string[] {
  const hit = findField(spec, catalog);
  return hit ? [hit.name] : spec.fallback;
}

/** Every leadership field for one object, as names to request. */
export function requestedNames(
  object: HubspotObjectType,
  catalog: HubspotPropertyDefinition[] | null | undefined,
): string[] {
  return Object.values(LEADERSHIP_FIELDS as Record<string, FieldSpec>)
    .filter((spec) => spec.object === object)
    .flatMap((spec) => namesToRequest(spec, catalog));
}

/**
 * Reads a field off a record's properties, as the label HubSpot would show.
 *
 * An enumeration's stored value is translated through its options; several
 * values (a multi-select) come back joined by "; ". A value with no matching
 * option is kept as it is rather than dropped — it is still what HubSpot holds.
 */
export function readField(
  spec: FieldSpec,
  properties: Record<string, string | null | undefined>,
  catalog: HubspotPropertyDefinition[] | null | undefined,
): string | null {
  const hit = findField(spec, catalog);
  const names = hit ? [hit.name] : spec.fallback;

  for (const name of names) {
    const raw = properties[name]?.trim();
    if (!raw) continue;
    const options = hit?.options ?? [];
    if (!options.length) return raw;
    return raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => options.find((option) => option.value === part)?.label ?? part)
      .join('; ');
  }
  return null;
}

/**
 * Whether a stored label holds a value, compared the way HubSpot's "is any of"
 * compares: per option, ignoring case and punctuation, so "Background Checks"
 * matches "background_checks" when the field list could not be read.
 */
export function hasOption(stored: string | null | undefined, wanted: string): boolean {
  if (!stored) return false;
  const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normal(wanted);
  return stored.split(';').some((part) => normal(part) === target);
}
