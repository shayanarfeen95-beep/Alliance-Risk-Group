'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { decideAccountMatch } from '@/lib/billing/accounts';
import type { ActionState } from './class-actions';

/**
 * Recording which QuickBooks customer a HubSpot account is.
 *
 * Returns its failure rather than throwing it, as the class mapping does, so a
 * rejected match says why on the screen instead of breaking it.
 */
export async function decideAccountMatchAction(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Your session has expired.' };
  if (!can(user, 'EDIT_MAPPINGS')) {
    return { error: 'Only an administrator or the CFO can match an account to a QuickBooks customer.' };
  }

  const companyId = String(formData.get('companyId') ?? '');
  const choice = String(formData.get('customerId') ?? '');
  if (!companyId) return { error: 'No account was named.' };
  if (!choice) return { error: 'Pick a QuickBooks customer, “No QuickBooks customer”, or “Automatic”.' };

  try {
    const db = await getDb();
    await decideAccountMatch(db, user.id, {
      companyId,
      customerId: choice === '__none__' ? null : choice === '__auto__' ? 'auto' : choice,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That match could not be saved.' };
  }

  revalidatePath('/admin');
  revalidatePath('/accounts');
  return {
    ok:
      choice === '__none__'
        ? 'Saved: no QuickBooks customer.'
        : choice === '__auto__'
          ? 'Back to the automatic match.'
          : 'Match saved.',
  };
}
