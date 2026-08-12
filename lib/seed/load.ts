/**
 * Loads the generated dataset into the warehouse.
 *
 * This stands in for the QBO / HubSpot / Sheets connectors until credentials are
 * provisioned at kickoff (§14.1). It writes through the same `load_run`
 * provenance the live connectors use, so nothing downstream can tell the
 * difference — and flipping to live data changes the source of the rows, not the
 * shape of anything that reads them.
 */
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { DIVISION_SEED } from '@/lib/divisions';
import { ALL_ACCOUNTS, MARKETING_SPEND_ACCOUNTS, SALES_AND_MARKETING_SPEND_ACCOUNTS } from '@/lib/seed/accounts';
import {
  allMonthsIncludingOpen,
  daysInMonth,
  generateSeedDataset,
  LAST_CLOSED_MONTH,
} from '@/lib/seed/generate';
import { hashPassword } from '@/lib/auth/password';
import { persistFindings, runAllChecks } from '@/lib/recon/checks';
import { DEFAULT_GOALS, evaluateGoalsForUser, persistFindings as persistGoalFindings } from '@/lib/ai/goals';
import { generateCommentary } from '@/lib/ai/commentary';
import { openSemanticSession } from '@/lib/semantic/resolve';

const CHUNK = 400;

async function insertChunked<T>(
  db: Database,
  table: Parameters<Database['insert']>[0],
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table).values(rows.slice(i, i + CHUNK) as any);
  }
}

const n = (value: Decimal) => value.toFixed(4);

/** Dev credentials. Replace before any real deployment. */
export const DEV_PASSWORD = 'westport2026';

export const SEED_USERS = [
  {
    email: 'admin@westportfinancial.com',
    name: 'Systems Admin',
    role: 'ADMIN' as const,
    canViewConsolidated: true,
    divisions: [] as string[],
  },
  {
    email: 'cfo@westportfinancial.com',
    name: 'Westport Financial',
    role: 'CFO' as const,
    canViewConsolidated: true,
    divisions: [],
  },
  {
    email: 'ceo@alliancerisk.com',
    name: 'ARG Chief Executive',
    role: 'EXECUTIVE' as const,
    canViewConsolidated: true,
    divisions: [],
  },
  {
    // Demonstrates the entitlement path: this user can never see ARG Total,
    // because the consolidated figure would leak the other three divisions.
    email: 'claims.lead@alliancerisk.com',
    name: 'Claims Division Manager',
    role: 'DIVISION_MANAGER' as const,
    canViewConsolidated: false,
    divisions: ['CLAIMS'],
  },
];

/**
 * §14.3 — open items that are Westport decisions, not developer guesses. They
 * live as data and are visible in the admin area. Where `isConfirmed` is false,
 * the dependent surfaces render "pending definition" rather than computing on an
 * assumption.
 */
export const SEED_CONFIG = [
  {
    key: 'BALANCE_SHEET_CLASSED',
    value: 'true',
    description:
      'Open item 1 — does ARG class its balance sheet in QBO? Determines whether DSO, DPO, CCC and Cash Runway are available by division or only at ARG Total (Defect 2). SEEDED DEFAULT: assumed true so the Finance dashboard is exercised end to end. Westport must confirm at kickoff; setting this to false switches those four KPIs to ARG-Total-only with a visible label rather than showing zeros.',
    isConfirmed: true,
  },
  {
    key: 'HUBSPOT_DIVISION_ATTRIBUTION',
    value: 'deal_property',
    description:
      'Open item 2 — how a HubSpot deal is attributed to a division: deal_property | pipeline | owner | none. SEEDED DEFAULT: deal_property, so the Sales and Marketing dashboards are exercised by division. Westport confirms the real rule in week 1; setting this to "none" reports those KPIs at ARG Total only rather than inventing an attribution rule.',
    isConfirmed: true,
  },
  {
    key: 'CLAIMS_SYSTEM_OF_RECORD',
    value: '',
    description: 'Open item 3 — the Claims operational system, not yet identified.',
    isConfirmed: false,
  },
  {
    key: 'MARKETING_SPEND_ACCOUNTS',
    value: MARKETING_SPEND_ACCOUNTS.join(','),
    description:
      'Open item 4a — QBO accounts constituting marketing spend (CPL, ROAS, Marketing Efficiency Ratio). SEEDED DEFAULT pending Westport sign-off. Clearing the confirmation withholds all three KPIs rather than computing them on an unagreed denominator.',
    isConfirmed: true,
  },
  {
    key: 'SALES_AND_MARKETING_SPEND_ACCOUNTS',
    value: SALES_AND_MARKETING_SPEND_ACCOUNTS.join(','),
    description:
      'Open item 4b — QBO accounts constituting sales AND marketing spend (the CAC numerator). A deliberately different, larger set than 4a. SEEDED DEFAULT pending Westport sign-off.',
    isConfirmed: true,
  },
  {
    key: 'ACCOUNTING_BASIS',
    value: 'accrual',
    description: 'Rule 3 — ARG reports on the accrual basis. Stated on the face of every view.',
    isConfirmed: true,
  },
  {
    key: 'DEFAULT_REPORTING_MONTH',
    value: LAST_CLOSED_MONTH,
    description: 'The most recent closed month. §13.1 uses March 2026 for tie-out.',
    isConfirmed: true,
  },
];

export interface SeedOptions {
  /** Suppresses the summary output when seeding inside a test. */
  quiet?: boolean;
}

export async function seedDatabase(db: Database, options: SeedOptions = {}): Promise<void> {
  const log = options.quiet ? () => {} : (line: string) => console.log(line);

  // Order matters: facts are written while every period is still open, then the
  // closed-period guard is switched on by closing the months.
  await db.execute(sql`
    truncate table
      ai_query_log, agent_finding, agent_goal, generated_view, agent_conversation,
      upload_file, monthly_commentary, variance_explanation, recon_result,
      audit_event, raw_payload,
      fact_headcount, fact_meeting, fact_deal_stage_history, fact_deal, fact_contact,
      fact_forecast, forecast_lock_waiver, forecast_version,
      fact_budget, fact_aging, fact_gl_balance, fact_bs_actual, fact_pl_actual,
      account_spend_tag, dim_account, budget_scenario,
      sessions, user_division_access, users, dim_period, dim_division, app_config
    restart identity cascade
  `);

  // --- Reference data ------------------------------------------------------
  await db.insert(t.appConfig).values(SEED_CONFIG);

  await db.insert(t.dimDivision).values(DIVISION_SEED);

  const months = allMonthsIncludingOpen();
  await db.insert(t.dimPeriod).values(
    months.map((m) => ({
      periodMonth: m.key,
      fiscalYear: m.year, // §7: ARG's fiscal year equals the calendar year.
      monthOfYear: m.month,
      daysInMonth: daysInMonth(m.year, m.month),
      isClosed: false,
    })),
  );

  await db.insert(t.dimAccount).values(
    ALL_ACCOUNTS.map((a) => ({
      accountId: a.accountId,
      accountNumber: a.accountNumber,
      accountName: a.accountName,
      accountType: a.accountType,
      reportingLine: a.reportingLine,
      balanceSheetLine: a.balanceSheetLine,
    })),
  );

  await db.insert(t.accountSpendTag).values([
    ...MARKETING_SPEND_ACCOUNTS.map((accountId) => ({ accountId, tag: 'MARKETING_SPEND' })),
    ...SALES_AND_MARKETING_SPEND_ACCOUNTS.map((accountId) => ({
      accountId,
      tag: 'SALES_AND_MARKETING_SPEND',
    })),
  ]);

  await db.insert(t.budgetScenario).values([
    {
      scenarioCode: 'MONTHLY_BUDGET',
      scenarioName: 'FY2026 Operating Budget',
      description: 'The monthly operating budget for fiscal 2026.',
      firstMonth: '2026-01-01',
      lastMonth: '2026-12-01',
      sortOrder: 1,
    },
    {
      scenarioCode: 'TENX',
      scenarioName: '10X Growth Plan',
      description: 'The 10X plan, 2026–2029. Annual targets divided straight-line by 12.',
      firstMonth: '2026-01-01',
      lastMonth: '2029-12-01',
      sortOrder: 2,
    },
  ]);

  // --- Users ---------------------------------------------------------------
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const insertedUsers = await db
    .insert(t.users)
    .values(
      SEED_USERS.map((u) => ({
        email: u.email,
        name: u.name,
        role: u.role,
        canViewConsolidated: u.canViewConsolidated,
        passwordHash,
      })),
    )
    .returning();

  const access = SEED_USERS.flatMap((u) => {
    const created = insertedUsers.find((row) => row.email === u.email);
    if (!created) return [];
    return u.divisions.map((divisionCode) => ({ userId: created.id, divisionCode }));
  });
  if (access.length) await db.insert(t.userDivisionAccess).values(access);

  // --- Standing goals ------------------------------------------------------
  // Every user starts with the default watch list, so the Executive exception
  // panel is useful on day one rather than empty until somebody configures it.
  // Each goal is scoped to its owner, so a division manager's goals can only
  // ever produce findings about divisions that manager may see.
  await db.insert(t.agentGoal).values(
    insertedUsers.flatMap((user) =>
      DEFAULT_GOALS.map((goal) => ({
        userId: user.id,
        name: goal.name,
        instruction: goal.instruction,
        evaluator: goal.evaluator,
        params: goal.params as object | null,
        cadence: goal.cadence,
      })),
    ),
  );

  // --- Facts, through a real load run --------------------------------------
  const dataset = generateSeedDataset();

  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem: 'SEED',
      entity: 'full_history',
      windowStart: months[0]!.key,
      windowEnd: months[months.length - 1]!.key,
      status: 'RUNNING',
      plan: {
        note: 'Seed load standing in for QBO/HubSpot until credentials are provisioned (§14.1).',
      },
    })
    .returning();
  const loadRunId = run!.id;

  await insertChunked(
    db,
    t.factPlActual,
    dataset.pl.map((r) => ({
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      revenue: n(r.revenue),
      payrollDirect: n(r.payrollDirect),
      cogs: n(r.cogs),
      payrollExpense: n(r.payrollExpense),
      opex: n(r.opex),
      basis: 'accrual' as const,
      sourceSystem: 'SEED' as const,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factGlBalance,
    dataset.gl.map((r) => ({
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      accountId: r.accountId,
      amount: n(r.amount),
      basis: 'accrual' as const,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factBsActual,
    dataset.bs.map((r) => ({
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      cash: n(r.cash),
      accountsReceivable: n(r.accountsReceivable),
      otherCurrentAssets: n(r.otherCurrentAssets),
      fixedAssets: n(r.fixedAssets),
      accountsPayable: n(r.accountsPayable),
      ccLiability: n(r.ccLiability),
      otherCurrentLiabilities: n(r.otherCurrentLiabilities),
      ltLiabilities: n(r.ltLiabilities),
      shareholderEquity: n(r.shareholderEquity),
      basis: 'accrual' as const,
      sourceSystem: 'SEED' as const,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factAging,
    dataset.aging.map((r) => ({
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      kind: r.kind,
      bucket: r.bucket,
      amount: n(r.amount),
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factBudget,
    dataset.budget.map((r) => ({
      scenarioCode: r.scenarioCode,
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      lineItem: r.lineItem,
      amount: n(r.amount),
      sourceSystem: 'SEED' as const,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factContact,
    dataset.contacts.map((r) => ({
      contactId: r.contactId,
      divisionCode: r.divisionCode,
      lifecycleStage: r.lifecycleStage,
      originalSource: r.originalSource,
      createdate: r.createdate,
      becameLeadDate: r.becameLeadDate,
      becameCustomerDate: r.becameCustomerDate,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factDeal,
    dataset.deals.map((r) => ({
      dealId: r.dealId,
      divisionCode: r.divisionCode,
      dealName: r.dealName,
      amount: n(r.amount),
      dealstage: r.dealstage,
      pipeline: r.pipeline,
      isClosedWon: r.isClosedWon,
      isClosed: r.isClosed,
      createdate: r.createdate,
      closedate: r.closedate,
      enteredProposalAt: r.enteredProposalAt,
      ownerId: r.ownerId,
      contactId: r.contactId,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factDealStageHistory,
    dataset.stageHistory.map((r) => ({
      dealId: r.dealId,
      stage: r.stage,
      enteredAt: r.enteredAt,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factMeeting,
    dataset.meetings.map((r) => ({
      meetingId: r.meetingId,
      divisionCode: r.divisionCode,
      meetingDate: r.meetingDate,
      outcome: r.outcome,
      ownerId: r.ownerId,
      associatedDealId: r.associatedDealId,
      loadRunId,
    })),
  );

  await insertChunked(
    db,
    t.factHeadcount,
    dataset.headcount.map((r) => ({
      periodMonth: r.periodMonth,
      divisionCode: r.divisionCode,
      headcount: r.headcount.toFixed(2),
      sourceSystem: 'SEED' as const,
      loadRunId,
    })),
  );

  await db
    .update(t.loadRun)
    .set({
      status: 'SUCCEEDED',
      rowsRead: dataset.pl.length + dataset.gl.length + dataset.deals.length,
      rowsWritten:
        dataset.pl.length +
        dataset.gl.length +
        dataset.bs.length +
        dataset.aging.length +
        dataset.budget.length +
        dataset.deals.length +
        dataset.contacts.length +
        dataset.meetings.length +
        dataset.headcount.length,
      finishedAt: new Date(),
    })
    .where(sql`id = ${loadRunId}`);

  // --- Close the books through March 2026 ----------------------------------
  // §13.1: March 2026 is "the most recent closed month in the file". April is
  // left open so the open-period labelling and the agent's preliminary-answer
  // behaviour are exercised by real data.
  const cfo = insertedUsers.find((u) => u.email === 'cfo@westportfinancial.com');
  await db
    .update(t.dimPeriod)
    .set({ isClosed: true, closedAt: new Date(), closedBy: cfo?.id ?? null })
    .where(sql`period_month <= ${LAST_CLOSED_MONTH}`);

  // Rule 1: the checks are standing controls that run on every refresh, so the
  // seed leaves the warehouse with a real, visible pass/fail rather than an
  // empty status chip.
  const recon = await runAllChecks(db);
  await persistFindings(db, recon.findings, loadRunId);

  // Goals are evaluated on every refresh, and a seed is a refresh. Running them
  // here means the exception panel reflects the data that was just loaded rather
  // than waiting for the next overnight cycle.
  let goalFindings = 0;
  for (const user of insertedUsers) {
    const seedUser = SEED_USERS.find((u) => u.email === user.email);
    const findings = await evaluateGoalsForUser(
      db,
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as 'ADMIN',
        canViewConsolidated: user.canViewConsolidated,
        divisionCodes: seedUser?.divisions ?? [],
      },
      LAST_CLOSED_MONTH,
    );
    goalFindings += await persistGoalFindings(db, findings);

    // Westport drafts and signs the narrative, so it is written once, for the
    // last closed month, from the CFO's view. It lands unsigned.
    if (user.email === 'cfo@westportfinancial.com') {
      const session = await openSemanticSession(db, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as 'CFO',
        canViewConsolidated: user.canViewConsolidated,
        divisionCodes: [],
      }, LAST_CLOSED_MONTH);

      const commentary = await generateCommentary(session, findings);
      await db.insert(t.monthlyCommentary).values({
        periodMonth: LAST_CLOSED_MONTH,
        draft: commentary.body,
        citations: commentary.facts as unknown as object,
      });
    }
  }

  // Read back from the database rather than trusting the in-memory dataset —
  // a seed that reports what it intended to write is not a verification.
  const [plCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(t.factPlActual);
  const plCount = plCountRow?.count ?? 0;

  log(`  divisions      ${DIVISION_SEED.length}`);
  log(`  periods        ${months.length} (closed through ${LAST_CLOSED_MONTH}, ${'2026-04-01'} open)`);
  log(`  accounts       ${ALL_ACCOUNTS.length}`);
  log(`  P&L rows       ${plCount}`);
  log(`  GL rows        ${dataset.gl.length}`);
  log(`  balance sheet  ${dataset.bs.length}`);
  log(`  budget rows    ${dataset.budget.length}`);
  log(`  deals          ${dataset.deals.length}`);
  log(`  contacts       ${dataset.contacts.length}`);
  log(`  recon checks   ${recon.passed} pass, ${recon.failed} fail`);
  log(`  goal findings  ${goalFindings}`);
  log(`  meetings       ${dataset.meetings.length}`);
  log('');
  log(`  sign in as any of: ${SEED_USERS.map((u) => u.email).join(', ')}`);
  log(`  password: ${DEV_PASSWORD}  (development only)`);

}
