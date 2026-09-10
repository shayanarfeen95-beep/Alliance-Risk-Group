'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { saveView, deleteView } from '@/lib/views/store';
import { openSemanticSession } from '@/lib/semantic/resolve';
import { executeSavedView } from '@/lib/views/spec';

/**
 * Building a view from the form.
 *
 * The spec is executed before it is stored. A view that cannot render is not
 * saved, because the alternative is a permanently broken card on a dashboard
 * whose author does not find out until they next open the page — and by then
 * they have forgotten what they asked for.
 */
export async function createViewAction(
  _previous: { error?: string; ok?: boolean } | null,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await getSessionUser();
  if (!user) return { error: 'Your session has expired.' };

  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Give the view a name.' };

  const kind = String(formData.get('kind') ?? 'pipeline');
  const month = String(formData.get('month') ?? '');

  const list = (field: string): string[] | undefined => {
    const values = formData.getAll(field).map(String).filter(Boolean);
    return values.length ? values : undefined;
  };

  const spec =
    kind === 'metric'
      ? {
          kind: 'metric' as const,
          title: name,
          form: String(formData.get('metricForm') ?? 'line') as 'line',
          kpis: list('kpis') ?? [],
          dimension: String(formData.get('dimension') ?? 'month') as 'month',
          trailingMonths: Number(formData.get('trailingMonths') ?? 12),
        }
      : {
          kind: 'pipeline' as const,
          title: name,
          form: String(formData.get('form') ?? 'horizontalBar') as 'horizontalBar',
          groupBy: String(formData.get('groupBy') ?? 'stage') as 'stage',
          measure: String(formData.get('measure') ?? 'amount') as 'amount',
          filters: {
            status: String(formData.get('status') ?? 'all') as 'all',
            owners: list('owners'),
            sources: list('sources'),
            stages: list('stages'),
            dateField: String(formData.get('dateField') ?? 'closedate') as 'closedate',
            trailingMonths: Number(formData.get('trailingMonths') ?? 12),
          },
        };

  try {
    const db = await getDb();
    const session = await openSemanticSession(db, user, month);

    // Render it once, here, so a spec that cannot resolve is refused now.
    executeSavedView(session, spec);

    await saveView(db, user, {
      name,
      description: String(formData.get('description') ?? '').trim() || null,
      spec,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The view could not be saved.' };
  }

  revalidatePath('/views');
  return { ok: true };
}

export async function deleteViewAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const db = await getDb();
  await deleteView(db, user, String(formData.get('id')));
  revalidatePath('/views');
}
