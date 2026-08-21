import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import {
  divisionForDeal,
  loadHubspotMapping,
  type HubspotDealPayload,
  type HubspotMapping,
} from '@/lib/connectors/hubspot-mapping';

/**
 * HubSpot raw → facts.
 *
 * The gap this closes: a confirmed extraction used to land HubSpot's JSON in
 * `raw_payload` and stop there. The records were real, the load run said
 * "succeeded", and not one figure on the Sales or Marketing dashboard moved,
 * because nothing ever conformed those payloads into `fact_deal`,
 * `fact_contact` or `fact_meeting`. That is the worst shape a data pipeline can
 * take — it reports success for work it did not do.
 *
 * Conform reads from the raw landing rather than the API, so it can be re-run
 * after a mapping changes without re-fetching anything. That matters: the
 * division mapping is a Westport decision that will be corrected at least once,
 * and correcting it must not depend on HubSpot still returning the same page of
 * deals.
 */

export interface ConformResult {
  entity: string;
  /** Rows written to the fact tables. */
  written: number;
  /** Deals whose division nobody has mapped. Counted, never guessed. */
  unattributed: number;
  /** Values seen with no mapping, most common first. */
  unmappedValues: string[];
  /** Stage-history rows written alongside the deals. */
  stageHistoryRows: number;
}

interface RawRow {
  payload: unknown;
  /** Provenance for a re-conform, where each row came from its own run. */
  loadRunId?: string | null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function date(value: unknown): Date | null {
  const text = str(value);
  if (!text) return null;
  // HubSpot returns both ISO strings and epoch milliseconds depending on the
  // property. A NaN date must not become "now" — it becomes null.
  const parsed = /^\d+$/.test(text) ? new Date(Number(text)) : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function money(value: unknown): string {
  const text = str(value);
  if (!text) return '0';
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0';
}

function truthy(value: unknown): boolean {
  const text = str(value)?.toLowerCase();
  return text === 'true' || text === 'yes' || text === '1';
}

/** The stage id that counts as a proposal, for New Proposals Sent. */
function isProposalStage(stage: string | null): boolean {
  return Boolean(stage && stage.toLowerCase().includes('proposal'));
}

export async function conformHubspot(
  db: Database,
  loadRunId: string,
  entity: string,
  rows: RawRow[],
): Promise<ConformResult> {
  switch (entity) {
    case 'deals':
      return conformDeals(db, loadRunId, rows);
    case 'contacts':
      return conformContacts(db, loadRunId, rows);
    case 'meetings':
      return conformMeetings(db, loadRunId, rows);
    default:
      return { entity, written: 0, unattributed: 0, unmappedValues: [], stageHistoryRows: 0 };
  }
}

/**
 * Re-runs conform over everything already landed for an entity.
 *
 * This is what makes a corrected mapping cheap: the raw payloads are still
 * there, so re-attributing every deal HubSpot ever sent is one pass over the
 * landing table rather than a re-fetch. Each row keeps its own load run as
 * provenance.
 */
export async function reconformLandedHubspot(
  db: Database,
  entity: string,
): Promise<ConformResult> {
  const rows = await db
    .select({ payload: t.rawPayload.payload, loadRunId: t.rawPayload.loadRunId })
    .from(t.rawPayload)
    .where(and(eq(t.rawPayload.sourceSystem, 'HUBSPOT'), eq(t.rawPayload.entity, entity)));

  if (rows.length === 0) {
    return { entity, written: 0, unattributed: 0, unmappedValues: [], stageHistoryRows: 0 };
  }
  return conformHubspot(db, rows[0]!.loadRunId, entity, rows);
}

async function activeDivisionCodes(db: Database): Promise<string[]> {
  const rows = await db
    .select({ divisionCode: t.dimDivision.divisionCode })
    .from(t.dimDivision)
    .where(eq(t.dimDivision.isActive, true));
  return rows.map((row) => row.divisionCode);
}

async function conformDeals(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<ConformResult> {
  const mapping: HubspotMapping = await loadHubspotMapping(db);
  const divisions = await activeDivisionCodes(db);

  const unmapped = new Map<string, number>();
  let unattributed = 0;
  let written = 0;
  let stageHistoryRows = 0;

  for (const row of rows) {
    const payload = row.payload as HubspotDealPayload;
    const dealId = str(payload.id);
    if (!dealId) continue;

    const runId = row.loadRunId ?? loadRunId;
    const properties = payload.properties ?? {};
    const divisionCode = divisionForDeal(mapping, payload, divisions);

    if (!divisionCode) {
      unattributed += 1;
      const raw = attributionValueForCounting(mapping, payload);
      if (raw) unmapped.set(raw, (unmapped.get(raw) ?? 0) + 1);
    }

    // Stage history first — New Proposals Sent needs the timestamp a deal
    // ENTERED the proposal stage, which the current stage cannot tell you.
    const history = payload.propertiesWithHistory?.dealstage ?? [];
    const proposalEntries = history
      .filter((entry) => isProposalStage(str(entry.value)))
      .map((entry) => date(entry.timestamp))
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime());

    await db
      .insert(t.factDeal)
      .values({
        dealId,
        divisionCode,
        dealName: str(properties.dealname),
        amount: money(properties.amount),
        dealstage: str(properties.dealstage),
        pipeline: str(properties.pipeline),
        isClosedWon: truthy(properties.hs_is_closed_won),
        isClosed: truthy(properties.hs_is_closed),
        createdate: date(properties.createdate),
        closedate: date(properties.closedate),
        enteredProposalAt: proposalEntries[0] ?? null,
        ownerId: str(properties.hubspot_owner_id),
        ownerName: str(properties.hubspot_owner_name) ?? str(properties.owner_name),
        loadRunId: runId,
      })
      .onConflictDoUpdate({
        target: t.factDeal.dealId,
        set: {
          divisionCode,
          dealName: str(properties.dealname),
          amount: money(properties.amount),
          dealstage: str(properties.dealstage),
          pipeline: str(properties.pipeline),
          isClosedWon: truthy(properties.hs_is_closed_won),
          isClosed: truthy(properties.hs_is_closed),
          createdate: date(properties.createdate),
          closedate: date(properties.closedate),
          enteredProposalAt: proposalEntries[0] ?? null,
          ownerId: str(properties.hubspot_owner_id),
          ownerName: str(properties.hubspot_owner_name) ?? str(properties.owner_name),
          loadRunId: runId,
        },
      });
    written += 1;

    for (const entry of history) {
      const stage = str(entry.value);
      const enteredAt = date(entry.timestamp);
      if (!stage || !enteredAt) continue;
      await db
        .insert(t.factDealStageHistory)
        .values({ dealId, stage, enteredAt, loadRunId: runId })
        .onConflictDoNothing();
      stageHistoryRows += 1;
    }
  }

  return {
    entity: 'deals',
    written,
    unattributed,
    unmappedValues: [...unmapped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => `${value} (${count})`),
    stageHistoryRows,
  };
}

/** Same extraction the mapping module does, kept separate so counting is cheap. */
function attributionValueForCounting(
  mapping: HubspotMapping,
  payload: HubspotDealPayload,
): string | null {
  const properties = payload.properties ?? {};
  if (mapping.rule === 'deal_property' && mapping.property) {
    return str(properties[mapping.property]);
  }
  if (mapping.rule === 'pipeline') return str(properties.pipeline);
  if (mapping.rule === 'owner') return str(properties.hubspot_owner_id);
  return null;
}

async function conformContacts(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<ConformResult> {
  let written = 0;

  for (const row of rows) {
    const payload = row.payload as HubspotDealPayload;
    const contactId = str(payload.id);
    if (!contactId) continue;
    const properties = payload.properties ?? {};

    const values = {
      // Contacts carry no division property in the entities this connector
      // reads, so they are held at ARG Total rather than attributed by
      // association — which would be an invented rule with extra steps.
      divisionCode: null,
      lifecycleStage: str(properties.lifecyclestage),
      originalSource: str(properties.hs_analytics_source),
      createdate: date(properties.createdate),
      becameLeadDate: date(properties.hs_lifecyclestage_lead_date),
      becameCustomerDate: date(properties.hs_lifecyclestage_customer_date),
      loadRunId: row.loadRunId ?? loadRunId,
    };

    await db
      .insert(t.factContact)
      .values({ contactId, ...values })
      .onConflictDoUpdate({ target: t.factContact.contactId, set: values });
    written += 1;
  }

  return { entity: 'contacts', written, unattributed: 0, unmappedValues: [], stageHistoryRows: 0 };
}

async function conformMeetings(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<ConformResult> {
  let written = 0;

  for (const row of rows) {
    const payload = row.payload as HubspotDealPayload;
    const meetingId = str(payload.id);
    if (!meetingId) continue;
    const properties = payload.properties ?? {};

    const meetingDate = date(properties.hs_meeting_start_time);
    // A meeting with no date cannot be counted in a period. Skipping it is
    // correct; dating it "today" would inflate the current month forever.
    if (!meetingDate) continue;

    const associatedDealId =
      str(payload.associations?.deals?.results?.[0]?.id) ??
      str(payload.associations?.deal?.results?.[0]?.id);

    // A meeting inherits its division from the deal it belongs to, when that
    // deal has one. That is not an attribution rule of its own — it is the deal's
    // rule, applied once.
    let divisionCode: string | null = null;
    if (associatedDealId) {
      const [deal] = await db
        .select({ divisionCode: t.factDeal.divisionCode })
        .from(t.factDeal)
        .where(eq(t.factDeal.dealId, associatedDealId))
        .limit(1);
      divisionCode = deal?.divisionCode ?? null;
    }

    const values = {
      divisionCode,
      meetingDate,
      outcome: str(properties.hs_meeting_outcome),
      ownerId: str(properties.hubspot_owner_id),
      associatedDealId,
      loadRunId: row.loadRunId ?? loadRunId,
    };

    await db
      .insert(t.factMeeting)
      .values({ meetingId, ...values })
      .onConflictDoUpdate({ target: t.factMeeting.meetingId, set: values });
    written += 1;
  }

  return { entity: 'meetings', written, unattributed: 0, unmappedValues: [], stageHistoryRows: 0 };
}

/** One line describing what a conform run did, for the transcript and the log. */
export function describeConform(result: ConformResult): string {
  if (result.written === 0) return `Nothing to conform for ${result.entity}.`;

  const parts = [
    `Conformed ${result.written} ${result.entity} into the warehouse`,
  ];
  if (result.stageHistoryRows) parts.push(`${result.stageHistoryRows} stage-history rows`);
  if (result.unattributed) {
    parts.push(
      `${result.unattributed} could not be attributed to a division${
        result.unmappedValues.length ? ` — unmapped values: ${result.unmappedValues.join(', ')}` : ''
      }. Those deals report at ARG Total only until the mapping covers them`,
    );
  }
  return `${parts.join('. ')}.`;
}
