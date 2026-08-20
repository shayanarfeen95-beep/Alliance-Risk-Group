import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { syncSource } from '@/lib/etl/sync';
import { getConnector } from '@/lib/connectors';
import type { SourceSystemCode } from '@/lib/connectors/types';

export const dynamic = 'force-dynamic';

/**
 * Refreshes a source, now, from Admin.
 *
 * The same `syncSource` the overnight refresh and the agent's confirmed
 * extraction call — pressing this button and asking the assistant to pull March
 * do the same work, in the same order, with the same stops. What it returns is
 * deliberately per-entity rather than a single verdict: "HubSpot synced" hides
 * that deals loaded and meetings were refused for a missing scope, and that is
 * exactly the thing somebody needs to see.
 */
export async function POST(request: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const sourceSystem = source.toUpperCase() as SourceSystemCode;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'RUN_INGESTION')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can run a sync.' },
      { status: 403 },
    );
  }

  let connector;
  try {
    connector = getConnector(sourceSystem);
  } catch {
    return NextResponse.json({ ok: false, error: `${source} is not a source.` }, { status: 404 });
  }

  let body: { fromMonth?: string; toMonth?: string; entities?: string[] } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is the common case — refresh everything, default window.
  }

  const { start, end } = defaultWindow(body.fromMonth, body.toMonth);

  const db = await getDb();
  const result = await syncSource(
    db,
    sourceSystem,
    { start, end },
    { requestedByUserId: user.id, entities: body.entities },
  );

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'SOURCE_SYNCED',
    entity: 'load_run',
    entityId: sourceSystem,
    detail: {
      window: `${start} → ${end}`,
      ok: result.ok,
      rowsWritten: result.rowsWritten,
      entities: result.entities.map((entity) => ({
        entity: entity.entity,
        ok: entity.ok,
        rowsWritten: entity.rowsWritten,
      })),
    },
  });

  return NextResponse.json({
    ok: result.ok,
    label: connector.label,
    rowsWritten: result.rowsWritten,
    window: `${start.slice(0, 7)} → ${end.slice(0, 7)}`,
    entities: result.entities.map((entity) => ({
      entity: entity.entity,
      ok: entity.ok,
      rowsRead: entity.rowsRead,
      rowsWritten: entity.rowsWritten,
      tables: entity.tables,
      warnings: entity.warnings,
      skippedClosedMonths: entity.skippedClosedMonths,
      error: entity.error,
      recon: entity.recon,
    })),
  });
}

/**
 * Three months by default, and a deliberate ceiling on the window.
 *
 * QuickBooks reports summarise by month OR by class but not both, so a window
 * is one API call per month per report, and Intuit is not fast. This function
 * runs under the 60-second limit set in `vercel.json`, and a pull that is cut
 * off at the timeout is worse than a smaller one: the run is left RUNNING, the
 * caller sees a network error, and whether anything was conformed is anybody's
 * guess.
 *
 * So the window is bounded here, and a longer backfill is a series of these
 * calls rather than one long one — which is what the client does. Three months
 * covers the nightly case exactly: the open month, plus two behind it for any
 * restatement that landed after close.
 */
const MAX_MONTHS = 6;

function defaultWindow(fromMonth?: string, toMonth?: string): { start: string; end: string } {
  const month = (value: string | undefined, fallback: Date): string => {
    if (value && /^\d{4}-\d{2}/.test(value)) return `${value.slice(0, 7)}-01`;
    return `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}-01`;
  };

  const now = new Date();
  const end = month(toMonth, now);
  const [endYear, endMonth] = end.split('-').map(Number) as [number, number];
  const start = month(fromMonth, new Date(Date.UTC(endYear, endMonth - 3, 1)));

  // Clamp rather than reject: a caller asking for two years gets the most
  // recent six months and can walk backwards, instead of an error that leaves
  // them with nothing.
  const [startYear, startMonth] = start.split('-').map(Number) as [number, number];
  const span = (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
  if (span > MAX_MONTHS) {
    const clamped = new Date(Date.UTC(endYear, endMonth - MAX_MONTHS, 1));
    return {
      start: `${clamped.getUTCFullYear()}-${String(clamped.getUTCMonth() + 1).padStart(2, '0')}-01`,
      end,
    };
  }

  return { start, end };
}
