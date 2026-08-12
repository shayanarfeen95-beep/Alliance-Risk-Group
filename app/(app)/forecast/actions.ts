'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  ForecastLockError,
  lockScenario,
  saveScenario,
  waiveForecastLock,
} from '@/lib/forecast/service';
import type { ForecastAssumptions } from '@/lib/forecast/engine';

export interface ForecastActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

export async function saveScenarioAction(
  _prev: ForecastActionState,
  formData: FormData,
): Promise<ForecastActionState> {
  try {
    const user = await requireUser();
    const month = String(formData.get('month'));
    const scenarioName = String(formData.get('scenarioName') ?? '').trim();
    if (!scenarioName) return { error: 'Give the scenario a name.' };

    const assumptions = JSON.parse(
      String(formData.get('assumptions') ?? '{}'),
    ) as Record<string, ForecastAssumptions>;
    const budgets = JSON.parse(String(formData.get('budgets') ?? '{}')) as Record<string, string>;

    await saveScenario(user, {
      month,
      scenarioName,
      assumptionsByDivision: assumptions,
      budgetedRevenueByDivision: budgets,
    });

    revalidatePath('/forecast');
    return { ok: true, message: `Saved “${scenarioName}”.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save the scenario.' };
  }
}

export async function lockScenarioAction(
  _prev: ForecastActionState,
  formData: FormData,
): Promise<ForecastActionState> {
  try {
    const user = await requireUser();
    const versionId = String(formData.get('versionId'));
    const correctionReason = String(formData.get('correctionReason') ?? '').trim() || undefined;

    await lockScenario(user, versionId, { correctionReason });
    revalidatePath('/forecast');
    revalidatePath('/forecast/accuracy');
    return {
      ok: true,
      message:
        'Locked. This version is now an immutable record — a correction creates a new version rather than editing this one.',
    };
  } catch (error) {
    if (error instanceof ForecastLockError) return { error: error.message };
    return { error: error instanceof Error ? error.message : 'Could not lock the forecast.' };
  }
}

export async function waiveLockAction(
  _prev: ForecastActionState,
  formData: FormData,
): Promise<ForecastActionState> {
  try {
    const user = await requireUser();
    await waiveForecastLock(user, String(formData.get('month')), String(formData.get('reason') ?? ''));
    revalidatePath('/forecast');
    return { ok: true, message: 'Waiver recorded against the period.' };
  } catch (error) {
    if (error instanceof ForecastLockError) return { error: error.message };
    return { error: error instanceof Error ? error.message : 'Could not record the waiver.' };
  }
}
