'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { decideClass } from '@/lib/etl/class-map';
import { reclaimRawPayloads } from '@/lib/etl/ingest';

export interface ActionState {
  error?: string;
  ok?: string;
}

/**
 * Recording what a class means.
 *
 * Returns its failure rather than throwing it. A server action that throws
 * becomes an unhandled error page, which is what happened when a mapping was
 * rejected: the screen broke instead of saying why, and the operator was left
 * guessing whether the class had been saved.
 */
export async function decideClassAction(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Your session has expired.' };
  if (!can(user, 'EDIT_MAPPINGS')) {
    return { error: 'Only an administrator or the CFO can map a class.' };
  }

  const classKey = String(formData.get('classKey') ?? '');
  const raw = String(formData.get('divisionCode') ?? '');

  if (raw === '') {
    return {
      error:
        'Pick a division, or "Not a division" — leaving it undecided is what blocks the month, ' +
        'so it is not something to save.',
    };
  }

  try {
    const db = await getDb();
    await decideClass(db, user, {
      classKey,
      // "__excluded__" is the explicit "this is not a division" answer, kept
      // distinct from an untouched select.
      divisionCode: raw === '__excluded__' ? null : raw,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That class could not be saved.' };
  }

  revalidatePath('/admin');
  return { ok: raw === '__excluded__' ? 'Excluded.' : `Mapped to ${raw}.` };
}

/**
 * Deleting landed payloads that nothing reads.
 *
 * The counterpart to landing having become selective: this is the space already
 * consumed by pulls made before that change.
 */
export async function reclaimStorageAction(
  _previous: ActionState | null,
): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Your session has expired.' };
  if (!can(user, 'RUN_INGESTION')) {
    return { error: 'Only an administrator or the CFO can reclaim storage.' };
  }

  try {
    const db = await getDb();
    const { deleted, kept } = await reclaimRawPayloads(db);
    revalidatePath('/admin');
    return {
      ok:
        deleted === 0
          ? 'Nothing to reclaim — no stored payload is unread.'
          : `Removed ${deleted.toLocaleString()} stored payloads that nothing reads. ` +
            `${kept.toLocaleString()} kept, because the owner lookup reads them.`,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Storage could not be reclaimed.',
    };
  }
}
