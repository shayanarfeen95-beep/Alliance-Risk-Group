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
  fetch(entity: string, window: FetchWindow): Promise<RawBatch>;
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
