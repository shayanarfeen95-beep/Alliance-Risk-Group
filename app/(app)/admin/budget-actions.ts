'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { readSpreadsheet } from '@/lib/upload/spreadsheet';
import { loadUploadedPlan } from '@/lib/etl/conform';
import { eq } from 'drizzle-orm';
import type { ActionState } from './class-actions';

/**
 * Uploading a budget or a forecast (Excel or CSV).
 *
 * Westport, November 2026: "Would like to upload a Budget and Forecast for 2027
 * and be able to have regular check-ins to how we are doing to plan." Until the
 * SharePoint file is connected, this is how a plan gets in. The upload lands as
 * a load run like any pull, so the audit trail shows who loaded what and when.
 */
export async function uploadPlanAction(_previous: ActionState | null, formData: FormData): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Your session has expired.' };
  if (!can(user, 'EDIT_MAPPINGS')) return { error: 'Only an administrator or the CFO can upload a budget or forecast.' };

  const file = formData.get('file');
  const kind = formData.get('kind') === 'forecast' ? 'forecast' : 'budget';
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose an Excel (.xlsx) or CSV file first.' };
  if (file.size > 7 * 1024 * 1024) return { error: 'That file is over 7 MB. Save just the budget sheet and upload that.' };

  let values: string[][];
  try {
    values = readSpreadsheet(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (error) {
    return { error: `That file could not be read: ${error instanceof Error ? error.message : 'unknown format'}.` };
  }
  if (values.length < 2) return { error: 'The first sheet is empty. Put the budget on the first sheet of the workbook.' };

  const db = await getDb();
  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem: 'UPLOAD',
      entity: kind === 'budget' ? 'uploaded_budget' : 'uploaded_forecast',
      status: 'RUNNING',
      requestedByUserId: user.id,
      confirmedAt: new Date(),
      startedAt: new Date(),
    })
    .returning();

  try {
    const result = await loadUploadedPlan(
      db,
      run!.id,
      kind,
      values,
      `${file.name}, uploaded by ${user.name ?? user.email} on ${new Date().toISOString().slice(0, 10)}`,
    );
    await db
      .update(t.loadRun)
      .set({ status: 'SUCCEEDED', rowsRead: values.length, rowsWritten: result.written, finishedAt: new Date() })
      .where(eq(t.loadRun.id, run!.id));
    revalidatePath('/', 'layout');
    const span = result.months.length === 2 ? ` covering ${result.months[0]!.slice(0, 7)} to ${result.months[1]!.slice(0, 7)}` : '';
    return {
      ok:
        `Loaded ${result.written.toLocaleString()} ${kind} figures from ${file.name}${span}. ` +
        (kind === 'budget'
          ? 'Finance, Executive and the KPI tiles now measure that year against it.'
          : 'The full-year outlook now uses it for the months it covers.') +
        (result.notes.length ? ` ${result.notes.join(' ')}` : ''),
    };
  } catch (error) {
    await db
      .update(t.loadRun)
      .set({
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(t.loadRun.id, run!.id));
    return { error: error instanceof Error ? error.message : 'The file could not be loaded.' };
  }
}
