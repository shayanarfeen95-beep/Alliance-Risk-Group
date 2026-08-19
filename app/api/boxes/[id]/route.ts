import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import { removeBox } from '@/lib/ai/boxes';

export const dynamic = 'force-dynamic';

/**
 * Removes a pinned box.
 *
 * Scoped to its owner in the query itself rather than by checking first and
 * deleting after — the two-step version is a race, and boxes are personal.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }

  const { id } = await context.params;
  const db = await getDb();
  const removed = await removeBox(db, user, id);

  if (!removed) {
    return NextResponse.json(
      { ok: false, error: 'That box is not yours, or is already gone.' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
