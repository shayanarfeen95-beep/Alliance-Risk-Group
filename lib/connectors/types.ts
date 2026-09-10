/**
 * Source connectors.
 *
 * Every source implements the same interface, so the ETL pipeline, the scheduled
 * overnight refresh and an agent-initiated "pull March from QuickBooks" all run
 * the identical code path and produce the identical `load_run` record. There is
 * no second, weaker ingestion path.
 *
 * §2 Rule 7: "Never modify source systems." No connector exposes a write
 * operation — not as a disabled flag, but as an absence. There is nothing to
 * call.
 */

export type SourceSystemCode = 'QBO' | 'HUBSPOT' | 'SHEETS' | 'UPLOAD' | 'MANUAL' | 'SEED';

export interface FetchWindow {
  /** First day of the first month, inclusive. */
  start: string;
  /** First day of the last month, inclusive. */
  end: string;
}

export interface RawRecord {
  entity: string;
  /** Natural key within the entity, for idempotency. */
  key: string;
  payload: unknown;
}

export interface RawBatch {
  sourceSystem: SourceSystemCode;
  entity: string;
  window: FetchWindow;
  records: RawRecord[];
  fetchedAt: Date;
  /**
   * Set when the connector stopped early and more remains.
   *
   * A pull is not one request. HubSpot paginates a hundred records at a time and
   * a real portal holds tens of thousands; QuickBooks wants a separate report
   * call per month. Fetching all of it inside one HTTP request is what made the
   * Pull button die at the platform timeout with nothing written and nothing
   * said. So a connector fetches until its deadline, hands back an opaque
   * position, and the caller comes straight back for the next slice.
   *
   * The value is the connector's own business — a HubSpot cursor, a month, a
   * sheet name. Nothing outside the connector may read it, only return it.
   */
  nextCursor?: string | null;
  /**
   * The newest source-side modification time in this batch.
   *
   * Becomes the next watermark once the entity finishes. A connector that
   * cannot report one leaves it undefined and is simply read in full every time
   * — which is the right answer for reference data small enough that asking
   * "what changed" costs more than re-reading it.
   */
  watermark?: Date | null;
}

/** How much of an entity to fetch, and where to resume from. */
export interface FetchOptions {
  /** An earlier batch's `nextCursor`, or null/undefined to start at the beginning. */
  cursor?: string | null;
  /**
   * Epoch milliseconds after which the connector should stop at the next safe
   * boundary and return a cursor. A slice that overruns is killed by the
   * platform mid-write, so the budget has to be respected by the fetcher rather
   * than enforced around it.
   */
  deadline?: number;
  /**
   * How many records one slice may return.
   *
   * Time alone is not enough of a bound. Fetching is fast and conforming is not
   * — every HubSpot deal is an upsert plus a stage-history rewrite — so a slice
   * that spent its whole budget fetching would hand conform more work than the
   * rest of the invocation can absorb, and be killed after the network calls
   * rather than before them. Capping the haul caps the write that follows it.
   */
  maxRecords?: number;
  /**
   * Only fetch what changed after this moment.
   *
   * Null or absent means a full read — the first sync of an entity, or one the
   * operator asked to redo from scratch. Set, it is the watermark from the last
   * completed pass, and the connector is expected to ask the source for its
   * changes rather than filtering a full crawl locally: filtering locally would
   * still walk every record, which is the cost this exists to avoid.
   */
  since?: Date | null;
}

/**
 * True when a slice should stop and hand back a cursor — because its time is up,
 * or because it is already holding as much as the conform step can take.
 */
export function budgetSpent(options: FetchOptions | undefined, recordsHeld = 0): boolean {
  if (options?.maxRecords !== undefined && recordsHeld >= options.maxRecords) return true;
  return options?.deadline !== undefined && Date.now() >= options.deadline;
}

/** What a connector can be asked to produce. */
export interface EntityDescriptor {
  entity: string;
  label: string;
  /** §5.3 refresh cadence. */
  cadence: 'DAILY' | 'ON_CLOSE' | 'MONTHLY' | 'WEEKLY';
  description: string;
}

export interface SourceConnector {
  readonly sourceSystem: SourceSystemCode;
  readonly label: string;
  /** Entities this connector can fetch — surfaced to the agent as options. */
  entities(): EntityDescriptor[];
  /**
   * True when usable credentials exist, from the store or the environment.
   *
   * Asynchronous because credentials live in the database once somebody has
   * clicked Connect. A synchronous version could only read `process.env`, and
   * would report a connected source as unconnected — or worse, the reverse.
   */
  isConfigured(): Promise<boolean>;
  fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch>;
}

export class ConnectorNotConfiguredError extends Error {
  constructor(public readonly sourceSystem: SourceSystemCode) {
    super(
      `${sourceSystem} is not configured. Add its credentials to the environment. ` +
        `Until then this source reports as not connected rather than returning empty data — ` +
        `an empty result and a missing connection must never look the same.`,
    );
    this.name = 'ConnectorNotConfiguredError';
  }
}

export class ConnectorRequestError extends Error {
  constructor(
    public readonly sourceSystem: SourceSystemCode,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${sourceSystem} request failed with HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'ConnectorRequestError';
  }
}

/**
 * Retries on 429 and 5xx with exponential backoff. Both QBO and HubSpot rate
 * limit aggressively, and an overnight refresh that dies on a single 429 is a
 * refresh that silently stops being current.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  sourceSystem: SourceSystemCode,
  maxAttempts = 5,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastError = err as Error;
      continue;
    }

    if (response.ok) return response;
    if (response.status !== 429 && response.status < 500) {
      throw new ConnectorRequestError(sourceSystem, response.status, await response.text());
    }
    lastError = new ConnectorRequestError(sourceSystem, response.status, await response.text());
  }

  throw lastError ?? new Error(`${sourceSystem} request failed`);
}

/** Enumerates the first-of-month dates covered by a window. */
export function monthsInWindow(window: FetchWindow): string[] {
  const months: string[] = [];
  const [startYear, startMonth] = window.start.split('-').map(Number) as [number, number];
  const [endYear, endMonth] = window.end.split('-').map(Number) as [number, number];

  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export function lastDayOfMonth(firstOfMonth: string): string {
  const [year, month] = firstOfMonth.split('-').map(Number) as [number, number];
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
