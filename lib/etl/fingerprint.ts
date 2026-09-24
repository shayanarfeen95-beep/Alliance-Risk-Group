import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { monthsInWindow, type FetchWindow, type RawBatch, type SourceConnector } from '@/lib/connectors/types';
import { addMonths, type MonthKey } from '@/lib/semantic/periods';

/**
 * Importing only what is new or changed.
 *
 * Every pull used to re-import every month in its window — a year of closed,
 * unchanged QuickBooks months rewritten on each press of Pull and again every
 * night, and a log that could not say what had actually changed. Now each piece
 * of source data carries a fingerprint of what it looked like when it was last
 * imported (sync_fingerprint), and a pull:
 *
 *   1. decides which QuickBooks months could have changed — months never
 *      loaded, the latest three (books still moving), and months QuickBooks'
 *      change feed says were edited since the last check — and fetches only
 *      those;
 *   2. compares what it fetched with the fingerprint, and imports only what is
 *      different;
 *   3. says, per month and per tab, which were new, which changed and which
 *      were left alone.
 *
 * "Re-import everything" skips all of it. HubSpot is not here: it already asks
 * HubSpot only for records modified since the last pull (sync_state).
 */

/**
 * Bumped whenever conform changes how the same source data becomes figures.
 *
 * It is part of every fingerprint, so a fix to the importer re-imports the data
 * it affects on the next pull without anybody having to know to press
 * "Re-import everything" — which is what the parent-account fix needed.
 */
export const CONFORM_VERSION = '2026-09-24.2';

/** Reports fetched one month at a time, fingerprinted per month. */
const MONTHLY: Record<string, { cumulative: boolean }> = {
  'QBO:profit_and_loss': { cumulative: false },
  // A balance is the sum of everything before it: an edit in March moves every
  // balance sheet from March on.
  'QBO:balance_sheet': { cumulative: true },
  'QBO:trial_balance': { cumulative: true },
};

/** Fetched whole, fingerprinted as one piece. */
const WHOLE = new Set([
  'QBO:accounts',
  'QBO:classes',
  'QBO:budgets',
  'QBO:ar_aging',
  'QBO:ap_aging',
  'SHEETS:monthly_budget',
  'SHEETS:tenx_budget',
  'SHEETS:forecast',
  'SHEETS:headcount',
]);

/** Entities whose figures depend on how QuickBooks classes map to divisions. */
const USES_CLASS_MAP = new Set([
  'QBO:profit_and_loss',
  'QBO:balance_sheet',
  'QBO:ar_aging',
  'QBO:ap_aging',
  'QBO:budgets',
]);

/** Months at the end of the window always re-checked: their books are still moving. */
export const RECENT_MONTHS = 3;

/** QuickBooks keeps change data for 30 days. */
const CHANGE_FEED_DAYS = 29;

const MAPPING_SCOPE = '__importer__';

export function isFingerprinted(source: string, entity: string): boolean {
  return Boolean(MONTHLY[`${source}:${entity}`]) || WHOLE.has(`${source}:${entity}`);
}

export function isMonthly(source: string, entity: string): boolean {
  return Boolean(MONTHLY[`${source}:${entity}`]);
}

/**
 * Canonical JSON: keys sorted, and the fields a source stamps on every response
 * regardless of content (QuickBooks' report time, a query's timestamp) removed —
 * otherwise nothing would ever look unchanged.
 */
function canonical(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'time' || key === 'Time' || key === 'fetchedAt') continue;
      out[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown, salt = ''): string {
  return createHash('sha256')
    .update(CONFORM_VERSION)
    .update('\u0000')
    .update(salt)
    .update('\u0000')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** How QuickBooks classes map today — part of the fingerprint of anything that uses it. */
async function classMapSignature(db: Database): Promise<string> {
  const rows = await db
    .select({
      classKey: t.dimClassMap.classKey,
      divisionCode: t.dimClassMap.divisionCode,
      decision: t.dimClassMap.decision,
    })
    .from(t.dimClassMap);
  rows.sort((a, b) => a.classKey.localeCompare(b.classKey));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

async function saltFor(db: Database, source: string, entity: string): Promise<string> {
  return USES_CLASS_MAP.has(`${source}:${entity}`) ? await classMapSignature(db) : '';
}

async function readPrints(db: Database, source: string, entity: string) {
  const rows = await db
    .select()
    .from(t.syncFingerprint)
    .where(and(eq(t.syncFingerprint.sourceSystem, source), eq(t.syncFingerprint.entity, entity)));
  return new Map(rows.map((row) => [row.scope, row]));
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthLabel(month: string): string {
  return month.slice(0, 7);
}

function ranges(months: string[]): string {
  if (!months.length) return '';
  if (months.length <= 4) return months.map(monthLabel).join(', ');
  return `${monthLabel(months[0]!)} … ${monthLabel(months[months.length - 1]!)} (${months.length} months)`;
}

export interface MonthPlan {
  /** The months to fetch. Empty means there is nothing that could have changed. */
  months: string[];
  notes: string[];
}

/**
 * Which months of a monthly QuickBooks report to fetch.
 *
 * Never guesses in the direction of skipping: when it cannot be sure a month is
 * unchanged — the change feed is out of reach, the last check is older than
 * QuickBooks keeps changes for, a deletion carries no date, the importer or the
 * class mapping changed — the month is fetched, and the fingerprint comparison
 * still stops an unchanged one from being re-imported.
 */
export async function planReportMonths(
  db: Database,
  connector: Pick<SourceConnector, 'changedMonths'>,
  source: string,
  entity: string,
  window: FetchWindow,
  today: Date = new Date(),
): Promise<MonthPlan> {
  const spec = MONTHLY[`${source}:${entity}`];
  const windowMonths = monthsInWindow(window);
  if (!spec) return { months: windowMonths, notes: [] };

  const prints = await readPrints(db, source, entity);
  const thisMonth = `${today.toISOString().slice(0, 7)}-01` as MonthKey;
  const recentFrom = addMonths(thisMonth, -(RECENT_MONTHS - 1));

  const importer = prints.get(MAPPING_SCOPE);
  const signature = contentHash(null, await saltFor(db, source, entity));
  if (importer && importer.contentHash !== signature) {
    return {
      months: windowMonths,
      notes: [
        'The importer or the class mapping changed since the last pull, so every month in the window was re-checked.',
      ],
    };
  }

  const missing = windowMonths.filter((month) => !prints.has(month));
  const recent = windowMonths.filter((month) => month >= recentFrom);
  const held = windowMonths.filter((month) => prints.has(month) && month < recentFrom);

  const fetch = new Set([...missing, ...recent]);
  const notes: string[] = [];
  let changed: string[] = [];

  if (held.length) {
    const oldest = held
      .map((month) => prints.get(month)!.checkedAt)
      .reduce((a, b) => (a < b ? a : b));
    const ageDays = (today.getTime() - oldest.getTime()) / 86_400_000;

    if (ageDays > CHANGE_FEED_DAYS || !connector.changedMonths) {
      held.forEach((month) => fetch.add(month));
      notes.push(
        `Months held since ${day(oldest)} were re-checked against QuickBooks: that is further back than ` +
          `QuickBooks keeps its change log. Only the ones that differ are re-imported.`,
      );
    } else {
      try {
        const feed = await connector.changedMonths(oldest);
        if (feed.undated > 0) {
          held.forEach((month) => fetch.add(month));
          notes.push(
            `QuickBooks reports ${feed.undated} deleted transaction${feed.undated === 1 ? '' : 's'} since ` +
              `${day(oldest)}, and a deletion carries no date — so every held month was re-checked.`,
          );
        } else {
          changed = held.filter((month) => feed.months.includes(month));
          if (spec.cumulative && changed.length) {
            const earliest = changed[0]!;
            changed = held.filter((month) => month >= earliest);
          }
          changed.forEach((month) => fetch.add(month));
        }
      } catch (error) {
        held.forEach((month) => fetch.add(month));
        notes.push(
          `QuickBooks' change log could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}), ` +
            `so every held month was re-checked.`,
        );
      }
    }
  }

  const months = windowMonths.filter((month) => fetch.has(month));
  const skipped = windowMonths.filter((month) => !fetch.has(month));
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} not yet loaded (${ranges(missing)})`);
  const recentHeld = recent.filter((month) => !missing.includes(month));
  if (recentHeld.length) parts.push(`${recentHeld.length} recent, books still open (${ranges(recentHeld)})`);
  if (changed.length) parts.push(`${changed.length} edited in QuickBooks since the last check (${ranges(changed)})`);
  notes.unshift(
    months.length
      ? `Fetched ${months.length} of ${windowMonths.length} months: ${parts.join('; ') || ranges(months)}.` +
          (skipped.length ? ` ${skipped.length} held unchanged and not fetched (${ranges(skipped)}).` : '')
      : `Nothing to fetch: all ${windowMonths.length} months are loaded and QuickBooks shows no change to them.`,
  );

  return { months, notes };
}

export interface Comparison {
  /** The batch with only new or changed records left in it. */
  batch: RawBatch;
  /** Every fingerprint computed, keyed by scope, to be saved once conform succeeds. */
  hashes: Map<string, string>;
  changedScopes: Set<string>;
  notes: string[];
}

/**
 * What in a fetched batch is new or different from the last import.
 *
 * With `incremental` false ("Re-import everything") nothing is dropped, but the
 * fingerprints are still computed so the next ordinary pull can compare.
 */
export async function compareBatch(
  db: Database,
  batch: RawBatch,
  incremental: boolean,
  today: Date = new Date(),
): Promise<Comparison> {
  const source = batch.sourceSystem;
  const entity = batch.entity;
  const monthly = isMonthly(source, entity);
  const whole = WHOLE.has(`${source}:${entity}`);
  const hashes = new Map<string, string>();
  const changedScopes = new Set<string>();

  // A whole-list fingerprint only means something for a complete list.
  if ((!monthly && !whole) || (whole && batch.nextCursor)) {
    return { batch, hashes, changedScopes, notes: [] };
  }

  const prints = await readPrints(db, source, entity);
  const salt = await saltFor(db, source, entity);

  if (monthly) {
    const kept = [];
    const unchanged: string[] = [];
    const fresh: string[] = [];
    const updated: string[] = [];
    for (const record of batch.records) {
      const hash = contentHash(record.payload, salt);
      hashes.set(record.key, hash);
      const before = prints.get(record.key);
      if (incremental && before?.contentHash === hash) {
        unchanged.push(record.key);
        continue;
      }
      changedScopes.add(record.key);
      (before ? updated : fresh).push(record.key);
      kept.push(record);
    }
    hashes.set(MAPPING_SCOPE, contentHash(null, salt));

    const notes: string[] = [];
    if (fresh.length) notes.push(`New: ${ranges(fresh)}.`);
    if (updated.length) {
      notes.push(
        incremental
          ? `Changed in QuickBooks since the last import, re-imported: ${ranges(updated)}.`
          : `Re-imported: ${ranges(updated)}.`,
      );
    }
    if (unchanged.length) notes.push(`Fetched and identical to what is loaded, not re-imported: ${ranges(unchanged)}.`);
    return { batch: { ...batch, records: kept }, hashes, changedScopes, notes };
  }

  // Aging is a snapshot of the month it is taken in; a new month is a new snapshot.
  const scope = entity.endsWith('_aging') ? `${today.toISOString().slice(0, 7)}-01` : 'all';
  const hash = contentHash(batch.records.map((record) => record.payload), salt);
  hashes.set(scope, hash);
  const before = prints.get(scope);

  if (incremental && before?.contentHash === hash) {
    return {
      batch: { ...batch, records: [] },
      hashes,
      changedScopes,
      notes: [`Unchanged since it was last imported on ${day(before.changedAt)} — not re-imported.`],
    };
  }
  changedScopes.add(scope);
  return {
    batch,
    hashes,
    changedScopes,
    notes: before ? [`Changed since the last import on ${day(before.changedAt)} — re-imported.`] : [],
  };
}

/** Records what was compared. Called only after conform has succeeded. */
export async function saveFingerprints(
  db: Database,
  source: string,
  entity: string,
  comparison: Pick<Comparison, 'hashes' | 'changedScopes'>,
  loadRunId: string,
): Promise<void> {
  const now = new Date();
  for (const [scope, contentHash] of comparison.hashes) {
    const changed = comparison.changedScopes.has(scope) || scope === MAPPING_SCOPE;
    await db
      .insert(t.syncFingerprint)
      .values({ sourceSystem: source, entity, scope, contentHash, checkedAt: now, changedAt: now, loadRunId })
      .onConflictDoUpdate({
        target: [t.syncFingerprint.sourceSystem, t.syncFingerprint.entity, t.syncFingerprint.scope],
        set: changed ? { contentHash, checkedAt: now, changedAt: now, loadRunId } : { checkedAt: now },
      });
  }
}

/**
 * Marks months that were deliberately not fetched as checked.
 *
 * They were not fetched because nothing says they changed — which is itself a
 * check, and the next pull's change-log lookup starts from here.
 */
export async function touchFingerprints(
  db: Database,
  source: string,
  entity: string,
  scopes: string[],
): Promise<void> {
  const now = new Date();
  for (const scope of scopes) {
    await db
      .update(t.syncFingerprint)
      .set({ checkedAt: now })
      .where(
        and(
          eq(t.syncFingerprint.sourceSystem, source),
          eq(t.syncFingerprint.entity, entity),
          eq(t.syncFingerprint.scope, scope),
        ),
      );
  }
}
