import { NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getDataMode, seedLoadRunIds, setDataMode, type DataMode } from '@/lib/data-mode';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Switching between demonstration data and ARG's own books, and — separately —
 * deleting the seeded rows for good.
 *
 * Two different promises, so two different actions. Switching to LIVE hides the
 * seed everywhere and is reversible by a click. Purging removes it, and is not.
 * Conflating them would mean an operator who wanted "stop showing me fake
 * numbers" got "your demonstration data is gone" as a side effect.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'EDIT_MAPPINGS')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can change the data mode.' },
      { status: 403 },
    );
  }

  let body: { mode?: DataMode; purgeSeed?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const db = await getDb();

  if (body.purgeSeed) {
    const runIds = await seedLoadRunIds(db);
    if (runIds.length === 0) {
      return NextResponse.json({ ok: true, purged: 0, message: 'There was no seeded data to remove.' });
    }

    // Facts first, then the run they hang off. Deleting the run first would
    // orphan the rows behind a foreign key and leave them visible forever.
    const tables = [
      t.factPlActual,
      t.factBsActual,
      t.factAging,
      t.factGlBalance,
      t.factBudget,
      t.factHeadcount,
      t.factDealStageHistory,
      t.factDeal,
      t.factContact,
      t.factMeeting,
      t.rawPayload,
    ];

    for (const table of tables) {
      await db.delete(table).where(inArray(table.loadRunId as never, runIds));
    }
    await db.delete(t.loadRun).where(inArray(t.loadRun.id, runIds));

    await db.insert(t.auditEvent).values({
      userId: user.id,
      action: 'SEED_DATA_PURGED',
      entity: 'load_run',
      detail: { runIds, note: 'Seeded demonstration rows deleted permanently.' },
    });

    return NextResponse.json({
      ok: true,
      purged: runIds.length,
      message:
        'The seeded dataset has been deleted. Every figure from here is one a source loaded, and ' +
        'a month nothing has loaded reads as unavailable.',
    });
  }

  const mode = body.mode === 'LIVE' ? 'LIVE' : 'DEMONSTRATION';
  await setDataMode(db, mode, user.id);

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'DATA_MODE_CHANGED',
    entity: 'app_config',
    entityId: 'DATA_MODE',
    detail: { mode },
  });

  return NextResponse.json({ ok: true, mode: await getDataMode(db) });
}
