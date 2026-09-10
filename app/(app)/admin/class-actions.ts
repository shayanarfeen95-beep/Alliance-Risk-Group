'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { decideClass } from '@/lib/etl/class-map';

export async function decideClassAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !can(user, 'EDIT_MAPPINGS')) return;

  const classKey = String(formData.get('classKey') ?? '');
  const raw = String(formData.get('divisionCode') ?? '');

  const db = await getDb();
  await decideClass(db, user, {
    classKey,
    // "__excluded__" is the explicit "not a division" answer, kept distinct from
    // an empty select that nobody has touched.
    divisionCode: raw === '__excluded__' || raw === '' ? null : raw,
  });

  revalidatePath('/admin');
}
