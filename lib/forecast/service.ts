import 'server-only';
import Decimal from 'decimal.js';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { d } from '@/lib/money';
import type { SessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { consolidate, project, type ForecastAssumptions, type ForecastProjection } from './engine';
import type { MonthKey } from '@/lib/semantic/periods';

export interface ScenarioSummary {
  id: string;
  scenarioName: string;
  isOfficial: boolean;
  isLocked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  correctionReason: string | null;
  supersedesVersionId: string | null;
  createdAt: string;
  rows: Array<{ divisionCode: string; assumptions: ForecastAssumptions; projection: ForecastProjection }>;
}

export async function listScenarios(month: MonthKey): Promise<ScenarioSummary[]> {
  const db = await getDb();

  const versions = await db
    .select({
      id: t.forecastVersion.id,
      scenarioName: t.forecastVersion.scenarioName,
      isOfficial: t.forecastVersion.isOfficial,
      isLocked: t.forecastVersion.isLocked,
      lockedAt: t.forecastVersion.lockedAt,
      correctionReason: t.forecastVersion.correctionReason,
      supersedesVersionId: t.forecastVersion.supersedesVersionId,
      createdAt: t.forecastVersion.createdAt,
      lockedByName: t.users.name,
    })
    .from(t.forecastVersion)
    .leftJoin(t.users, eq(t.users.id, t.forecastVersion.lockedBy))
    .where(eq(t.forecastVersion.periodMonth, month))
    .orderBy(desc(t.forecastVersion.createdAt));

  if (versions.length === 0) return [];

  const rows = await db
    .select()
    .from(t.factForecast)
    .where(eq(t.factForecast.periodMonth, month))
    .orderBy(asc(t.factForecast.divisionCode));

  return versions.map((version) => ({
    id: version.id,
    scenarioName: version.scenarioName,
    isOfficial: version.isOfficial,
    isLocked: version.isLocked,
    lockedAt: version.lockedAt?.toISOString() ?? null,
    lockedByName: version.lockedByName,
    correctionReason: version.correctionReason,
    supersedesVersionId: version.supersedesVersionId,
    createdAt: version.createdAt.toISOString(),
    rows: rows
      .filter((row) => row.forecastVersionId === version.id)
      .map((row) => ({
        divisionCode: row.divisionCode,
        assumptions: {
          revenuePctOfBudget: Number(row.assumRevenuePctOfBudget),
          payrollDirectPct: Number(row.assumPayrollDirectPct),
          cogsPct: Number(row.assumCogsPct),
          payrollExpenseAmt: Number(row.assumPayrollExpenseAmt),
          opexAmt: Number(row.assumOpexAmt),
        },
        projection: {
          revenue: d(row.fcRevenue),
          payrollDirect: d(row.fcPayrollDirect),
          cogs: d(row.fcCogs),
          grossProfit: d(row.fcGrossProfit),
          payrollExpense: d(row.fcPayrollExpense),
          opex: d(row.fcOpex),
          netProfit: d(row.fcNetProfit),
        },
      })),
  }));
}

export interface SaveScenarioInput {
  month: MonthKey;
  scenarioName: string;
  assumptionsByDivision: Record<string, ForecastAssumptions>;
  budgetedRevenueByDivision: Record<string, string>;
  notes?: string;
}

/** Saves an unlocked scenario. Scenarios are drafts until one is locked. */
export async function saveScenario(
  user: SessionUser,
  input: SaveScenarioInput,
): Promise<{ versionId: string }> {
  const db = await getDb();

  const [version] = await db
    .insert(t.forecastVersion)
    .values({
      periodMonth: input.month,
      scenarioName: input.scenarioName,
      notes: input.notes,
      createdBy: user.id,
    })
    .returning();

  const rows = Object.entries(input.assumptionsByDivision).map(([divisionCode, assumptions]) => {
    const projection = project(input.budgetedRevenueByDivision[divisionCode] ?? '0', assumptions);
    return {
      forecastVersionId: version!.id,
      periodMonth: input.month,
      divisionCode,
      assumRevenuePctOfBudget: String(assumptions.revenuePctOfBudget),
      assumPayrollDirectPct: String(assumptions.payrollDirectPct),
      assumCogsPct: String(assumptions.cogsPct),
      assumPayrollExpenseAmt: String(assumptions.payrollExpenseAmt),
      assumOpexAmt: String(assumptions.opexAmt),
      // §4.5 / Defect 4: all five lines are populated at save time. In the Excel
      // the FC Gross Profit column was never filled in, which gated off every
      // gross-profit variance column permanently.
      fcRevenue: projection.revenue.toFixed(4),
      fcPayrollDirect: projection.payrollDirect.toFixed(4),
      fcCogs: projection.cogs.toFixed(4),
      fcGrossProfit: projection.grossProfit.toFixed(4),
      fcPayrollExpense: projection.payrollExpense.toFixed(4),
      fcOpex: projection.opex.toFixed(4),
      fcNetProfit: projection.netProfit.toFixed(4),
      isLocked: false,
    };
  });

  if (rows.length) await db.insert(t.factForecast).values(rows);

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'FORECAST_SCENARIO_SAVED',
    entity: 'forecast_version',
    entityId: version!.id,
    detail: { month: input.month, scenarioName: input.scenarioName },
  });

  return { versionId: version!.id };
}

export class ForecastLockError extends Error {}

/**
 * §10.3 — locking is one action that writes an immutable, timestamped,
 * attributed record.
 *
 * A locked version can never be edited or deleted; a correction creates a NEW
 * version and both stay visible with a reason on the record. Immutability is
 * enforced by a database trigger, so this function is the only sanctioned path
 * but not the only thing standing in the way.
 */
export async function lockScenario(
  user: SessionUser,
  versionId: string,
  options: { correctionReason?: string } = {},
): Promise<void> {
  if (!can(user, 'LOCK_FORECAST')) {
    throw new ForecastLockError('You are not permitted to lock a forecast.');
  }

  const db = await getDb();
  const [version] = await db
    .select()
    .from(t.forecastVersion)
    .where(eq(t.forecastVersion.id, versionId))
    .limit(1);

  if (!version) throw new ForecastLockError('Scenario not found.');
  if (version.isLocked) throw new ForecastLockError('That version is already locked.');

  const [existingOfficial] = await db
    .select({ id: t.forecastVersion.id })
    .from(t.forecastVersion)
    .where(
      and(
        eq(t.forecastVersion.periodMonth, version.periodMonth),
        eq(t.forecastVersion.isOfficial, true),
      ),
    )
    .limit(1);

  // Superseding a locked forecast is a correction, and a correction needs a
  // stated reason on the record.
  if (existingOfficial && !options.correctionReason) {
    throw new ForecastLockError(
      'A locked forecast already exists for this month. Correcting it creates a new version, and a correction requires a reason on the record.',
    );
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    if (existingOfficial) {
      // The superseded version stays visible and stays locked; it simply stops
      // being the official one.
      await tx
        .update(t.forecastVersion)
        .set({ isOfficial: false })
        .where(eq(t.forecastVersion.id, existingOfficial.id));
    }

    await tx
      .update(t.forecastVersion)
      .set({
        isLocked: true,
        isOfficial: true,
        lockedAt: now,
        lockedBy: user.id,
        supersedesVersionId: existingOfficial?.id ?? null,
        correctionReason: options.correctionReason ?? null,
      })
      .where(eq(t.forecastVersion.id, versionId));

    await tx
      .update(t.factForecast)
      .set({ isLocked: true })
      .where(eq(t.factForecast.forecastVersionId, versionId));

    await tx.insert(t.auditEvent).values({
      userId: user.id,
      action: 'FORECAST_LOCKED',
      entity: 'forecast_version',
      entityId: versionId,
      detail: {
        month: version.periodMonth,
        supersedes: existingOfficial?.id ?? null,
        correctionReason: options.correctionReason ?? null,
      },
    });
  });
}

/**
 * §10.3 / Defect 4: "Block entry of a month's actuals until that month's
 * forecast is locked, or the lock is explicitly waived with a captured reason."
 */
export async function forecastGateStatus(
  month: MonthKey,
): Promise<{ locked: boolean; waived: boolean; waiverReason: string | null }> {
  const db = await getDb();

  const [official] = await db
    .select({ id: t.forecastVersion.id })
    .from(t.forecastVersion)
    .where(
      and(eq(t.forecastVersion.periodMonth, month), eq(t.forecastVersion.isOfficial, true)),
    )
    .limit(1);

  const [waiver] = await db
    .select({ reason: t.forecastLockWaiver.reason })
    .from(t.forecastLockWaiver)
    .where(eq(t.forecastLockWaiver.periodMonth, month))
    .limit(1);

  return {
    locked: Boolean(official),
    waived: Boolean(waiver),
    waiverReason: waiver?.reason ?? null,
  };
}

export async function waiveForecastLock(
  user: SessionUser,
  month: MonthKey,
  reason: string,
): Promise<void> {
  if (!can(user, 'WAIVE_FORECAST_LOCK')) {
    throw new ForecastLockError('You are not permitted to waive the forecast lock.');
  }
  const trimmed = reason.trim();
  // A waiver with no reason is the control failing silently, which is the
  // pattern this build exists to remove.
  if (trimmed.length < 10) {
    throw new ForecastLockError(
      'A waiver must state why the month is being closed without a locked forecast.',
    );
  }

  const db = await getDb();
  await db.insert(t.forecastLockWaiver).values({ periodMonth: month, reason: trimmed, waivedBy: user.id });
  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'FORECAST_LOCK_WAIVED',
    entity: 'dim_period',
    entityId: month,
    detail: { reason: trimmed },
  });
}

/** The locked forecast for a month, or null when none was ever locked. */
export async function officialForecast(
  month: MonthKey,
  divisions: string[],
): Promise<{ projection: ForecastProjection; lockedAt: string; lockedByName: string | null } | null> {
  const db = await getDb();

  const [version] = await db
    .select({
      id: t.forecastVersion.id,
      lockedAt: t.forecastVersion.lockedAt,
      lockedByName: t.users.name,
    })
    .from(t.forecastVersion)
    .leftJoin(t.users, eq(t.users.id, t.forecastVersion.lockedBy))
    .where(
      and(
        eq(t.forecastVersion.periodMonth, month),
        eq(t.forecastVersion.isOfficial, true),
        eq(t.forecastVersion.isLocked, true),
      ),
    )
    .limit(1);

  if (!version) return null;

  const rows = await db
    .select()
    .from(t.factForecast)
    .where(
      and(
        eq(t.factForecast.forecastVersionId, version.id),
        sql`${t.factForecast.divisionCode} in ${divisions}`,
      ),
    );

  if (rows.length === 0) return null;

  const projection = consolidate(
    rows.map((row) => ({
      revenue: d(row.fcRevenue),
      payrollDirect: d(row.fcPayrollDirect),
      cogs: d(row.fcCogs),
      grossProfit: d(row.fcGrossProfit),
      payrollExpense: d(row.fcPayrollExpense),
      opex: d(row.fcOpex),
      netProfit: d(row.fcNetProfit),
    })),
  );

  return {
    projection,
    lockedAt: version.lockedAt!.toISOString(),
    lockedByName: version.lockedByName,
  };
}

/** Budgeted revenue per division for a month — the base the forecast scales. */
export async function budgetedRevenue(
  month: MonthKey,
  divisions: string[],
): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db
    .select({ divisionCode: t.factBudget.divisionCode, amount: t.factBudget.amount })
    .from(t.factBudget)
    .where(
      and(
        eq(t.factBudget.scenarioCode, 'MONTHLY_BUDGET'),
        eq(t.factBudget.periodMonth, month),
        eq(t.factBudget.lineItem, 'revenue'),
      ),
    );

  const result: Record<string, string> = {};
  for (const division of divisions) result[division] = '0';
  for (const row of rows) {
    if (divisions.includes(row.divisionCode)) result[row.divisionCode] = row.amount;
  }
  return result;
}
