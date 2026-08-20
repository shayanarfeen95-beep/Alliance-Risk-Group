import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { CONNECTORS } from '@/lib/connectors';
import { syncSource } from '@/lib/etl/sync';

export const dynamic = 'force-dynamic';

/**
 * The overnight refresh — §5.3: open months refresh nightly.
 *
 * Three months, every connected source, in the same code path as the Sync
 * button and the agent's confirmed pull. Closed months are skipped inside
 * conform rather than filtered here, so the rule holds no matter which caller
 * runs the load.
 *
 * A source that is not connected is not an error. Most deployments will run
 * with one or two of the three attached, and a nightly job that reports failure
 * for the absent ones trains everybody to ignore it.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  // Unauthenticated refresh would let anyone on the internet burn ARG's
  // QuickBooks rate limit. With no secret configured the endpoint refuses
  // rather than running open — an unset variable must never be the permissive
  // case.
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: 'CRON_SECRET is not set, so the scheduled refresh is disabled rather than open.',
      },
      { status: 503 },
    );
  }

  const authorization = request.headers.get('authorization');
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 });
  }

  const now = new Date();
  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const start = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const db = await getDb();
  const results = [];

  for (const connector of CONNECTORS) {
    if (!(await connector.isConfigured())) {
      results.push({ source: connector.sourceSystem, skipped: 'not connected' });
      continue;
    }

    const result = await syncSource(db, connector.sourceSystem, { start, end });
    results.push({
      source: connector.sourceSystem,
      ok: result.ok,
      rowsWritten: result.rowsWritten,
      entities: result.entities.map((entity) => ({
        entity: entity.entity,
        ok: entity.ok,
        rowsWritten: entity.rowsWritten,
        error: entity.error,
      })),
    });
  }

  await db.insert(t.auditEvent).values({
    action: 'SCHEDULED_REFRESH',
    entity: 'load_run',
    entityId: `${start}..${end}`,
    detail: { results },
  });

  return NextResponse.json({ ok: true, window: `${start} → ${end}`, results });
}
