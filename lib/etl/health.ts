import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { CONNECTORS, type SourceSystemCode } from '@/lib/connectors';

/**
 * What is actually in the warehouse, and when a figure is missing, why.
 *
 * The complaint this exists to answer is "nothing on the dashboard works". That
 * was never one fault — it was three, and no screen could tell them apart:
 *
 *   nothing was fetched          (the source is not connected, or was never pulled)
 *   it was fetched and refused   (a class maps to no division, so the month was rejected)
 *   it loaded into other months  (the data is there, on a month the view is not on)
 *
 * All three render identically as an empty dashboard. Naming which one is
 * happening turns "it is broken" into a thing somebody can act on, and it is the
 * one view neither the operator nor anybody debugging this had.
 */

export type HealthState = 'LOADED' | 'BLOCKED' | 'NEVER_PULLED' | 'NOT_CONNECTED' | 'EMPTY';

export interface EntityHealth {
  source: SourceSystemCode;
  sourceLabel: string;
  entity: string;
  entityLabel: string;
  state: HealthState;
  /** Rows this entity has put into the warehouse. */
  rows: number;
  lastSyncedAt: Date | null;
  watermark: Date | null;
  /** Plain-English reason, always set when state is not LOADED. */
  detail: string;
}

export interface DataHealth {
  entities: EntityHealth[];
  /** Months that carry any figure at all — what the month selector can offer. */
  monthsWithData: string[];
  /** Classes still blocking a load. */
  unmappedClasses: string[];
  /** Stored payloads, so growth is visible rather than discovered. */
  storedPayloads: number;
}

/** Which fact table each entity fills, so "did it land" is answerable. */
const ROW_SOURCE: Record<string, () => { table: string; column?: string }> = {
  'QBO:profit_and_loss': () => ({ table: 'fact_pl_actual' }),
  'QBO:balance_sheet': () => ({ table: 'fact_bs_actual' }),
  'QBO:accounts': () => ({ table: 'dim_account' }),
  'QBO:classes': () => ({ table: 'dim_class_map' }),
  'HUBSPOT:deals': () => ({ table: 'fact_deal' }),
  'HUBSPOT:contacts': () => ({ table: 'fact_contact' }),
  'HUBSPOT:meetings': () => ({ table: 'fact_meeting' }),
  'HUBSPOT:companies': () => ({ table: 'fact_company' }),
  'HUBSPOT:deal_stages': () => ({ table: 'dim_deal_stage' }),
  'HUBSPOT:owners': () => ({ table: 'fact_deal', column: 'owner_name' }),
  'SHEETS:monthly_budget': () => ({ table: 'fact_budget' }),
  'SHEETS:tenx_budget': () => ({ table: 'fact_budget' }),
  'SHEETS:headcount': () => ({ table: 'fact_headcount' }),
};

export async function loadDataHealth(db: Database): Promise<DataHealth> {
  const [runs, syncRows, classRows, payloadCount, months] = await Promise.all([
    db
      .select({
        sourceSystem: t.loadRun.sourceSystem,
        entity: t.loadRun.entity,
        status: t.loadRun.status,
        error: t.loadRun.errorMessage,
        startedAt: t.loadRun.startedAt,
      })
      .from(t.loadRun)
      .where(sql`${t.loadRun.sourceSystem} <> 'SEED'`)
      .orderBy(desc(t.loadRun.startedAt))
      .limit(200),
    db.select().from(t.syncState),
    db.select().from(t.dimClassMap).where(eq(t.dimClassMap.decision, 'UNMAPPED')),
    db.select({ n: sql<number>`count(*)::int` }).from(t.rawPayload),
    monthsWithAnyData(db),
  ]);

  // The newest run per entity — the one that says what happened last.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    const key = `${run.sourceSystem}:${run.entity}`;
    if (!latest.has(key)) latest.set(key, run);
  }

  const entities: EntityHealth[] = [];

  for (const connector of CONNECTORS) {
    const connected = await connector.isConfigured();

    for (const descriptor of connector.entities()) {
      const key = `${connector.sourceSystem}:${descriptor.entity}`;
      const run = latest.get(key);
      const sync = syncRows.find(
        (row) => row.sourceSystem === connector.sourceSystem && row.entity === descriptor.entity,
      );
      const rows = await countRows(db, key);

      let state: HealthState;
      let detail: string;

      if (!connected) {
        state = 'NOT_CONNECTED';
        // Rows can exist while the source is disconnected — a previous load, or
        // a connection that was later removed. Saying only "not connected" over
        // a row count of two thousand reads as a contradiction, and the reader
        // cannot tell whether the figures on their dashboard are trustworthy.
        detail =
          rows > 0
            ? `${connector.label} is not signed in. The ${rows.toLocaleString()} rows shown were ` +
              `loaded earlier and are still being read by the dashboards; they will not refresh ` +
              `until it is reconnected.`
            : `${connector.label} is not signed in, so nothing can be fetched from it.`;
      } else if (!run) {
        state = 'NEVER_PULLED';
        detail = 'This has never been pulled. Press Pull everything in Admin.';
      } else if (run.status === 'FAILED') {
        state = 'BLOCKED';
        detail = run.error?.slice(0, 300) ?? 'The last pull failed and gave no reason.';
      } else if (rows === 0) {
        state = 'EMPTY';
        detail =
          run.status === 'RUNNING'
            ? 'A pull is part way through this entity. Press Pull again to continue it.'
            : 'The pull succeeded but wrote no rows — the source has nothing for this window.';
      } else {
        state = 'LOADED';
        detail = `${rows.toLocaleString()} rows in the warehouse.`;
      }

      entities.push({
        source: connector.sourceSystem,
        sourceLabel: connector.label,
        entity: descriptor.entity,
        entityLabel: descriptor.label,
        state,
        rows,
        lastSyncedAt: sync?.lastSyncedAt ?? null,
        watermark: sync?.watermark ?? null,
        detail,
      });
    }
  }

  return {
    entities,
    monthsWithData: months,
    unmappedClasses: classRows.map((row) => row.className),
    storedPayloads: payloadCount[0]?.n ?? 0,
  };
}

/** Rows an entity has actually put into the warehouse. */
async function countRows(db: Database, key: string): Promise<number> {
  const target = ROW_SOURCE[key]?.();
  if (!target) return 0;

  try {
    const where = target.column ? sql` where ${sql.raw(target.column)} is not null` : sql``;
    const result = await db.execute(
      sql`select count(*)::int as n from ${sql.raw(target.table)}${where}`,
    );
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
      n: number;
    }>;
    return Number(rows[0]?.n ?? 0);
  } catch {
    // A table that does not exist yet is zero rows, not an error page.
    return 0;
  }
}

/** Months carrying any figure, from any source. */
async function monthsWithAnyData(db: Database): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      select period_month from (
        select period_month from ${t.factPlActual}
        union select period_month from ${t.factBsActual}
        union select date_trunc('month', closedate)::date  from ${t.factDeal}    where closedate is not null
        union select date_trunc('month', createdate)::date from ${t.factContact} where createdate is not null
        union select date_trunc('month', meeting_date)::date from ${t.factMeeting} where meeting_date is not null
      ) m
      order by period_month desc limit 24`);

    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
      period_month: string | Date;
    }>;

    return rows.map((row) =>
      typeof row.period_month === 'string'
        ? row.period_month.slice(0, 10)
        : row.period_month.toISOString().slice(0, 10),
    );
  } catch {
    return [];
  }
}
