/**
 * Alliance Risk Group — warehouse schema.
 *
 * Spec §4 defines six tables. The grain and the relationships below are exactly
 * as specified; column names follow the spec where it names them.
 *
 * Three rules are enforced by the database itself rather than by application
 * code, because the spec requires controls that survive a developer mistake:
 *
 *   1. ARG Total is a computed rollup, never a stored row. A CHECK constraint on
 *      every fact table rejects it. (§3 — the Excel stores it as a row, which is
 *      exactly why it can drift from its parts.)
 *   2. A locked forecast is immutable. A trigger raises on UPDATE and DELETE.
 *      (§10.3 — "Enforce immutability at the database level, not only in the
 *      interface.")
 *   3. Division codes are foreign-keyed. Nothing lands unmapped and silently
 *      reads as $0. (Defect 1, Test 8.)
 *
 * Money is `numeric` — exact decimal, never float. Values are read as strings
 * and computed with decimal.js in the semantic layer. Round only for display.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Money column. 4dp so we store unrounded source values and round at display. */
const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', [
  'ADMIN', // full access incl. mappings, users, ingestion
  'CFO', // Westport — full read, close, lock, sign-off
  'EXECUTIVE', // CEO/COO — full read, no ingestion
  'DIVISION_MANAGER', // scoped to entitled divisions
  'VIEWER', // read-only, scoped
]);

/** §2 Rule 3: every financial view states its basis. Never mix silently. */
export const accountingBasis = pgEnum('accounting_basis', ['accrual', 'cash']);

export const sourceSystem = pgEnum('source_system', [
  'QBO',
  'HUBSPOT',
  'SHEETS',
  'UPLOAD',
  'MANUAL',
  'SEED',
]);

/** The five reporting lines the Excel carries per division per month. */
export const reportingLine = pgEnum('reporting_line', [
  'revenue',
  'payroll_direct', // MEMO — a component of cogs
  'cogs',
  'payroll_expense', // MEMO — a component of opex
  'opex',
]);

/** Budget line items. GP and NP are derived, never loaded (§4.4). */
export const budgetLineItem = pgEnum('budget_line_item', ['revenue', 'cogs', 'opex']);

export const loadRunStatus = pgEnum('load_run_status', [
  'PENDING',
  'PREVIEW', // agent computed a plan; awaiting human confirmation
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
]);

export const reconStatus = pgEnum('recon_status', ['PASS', 'FAIL', 'NOT_APPLICABLE']);

export const glAccountType = pgEnum('gl_account_type', [
  'INCOME',
  'COGS',
  'EXPENSE',
  'ASSET',
  'LIABILITY',
  'EQUITY',
]);

// ---------------------------------------------------------------------------
// Identity and access (§14.3 open item 5)
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('VIEWER'),
    /** false = scoped to the rows in user_division_access. */
    canViewConsolidated: boolean('can_view_consolidated').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const userDivisionAccess = pgTable(
  'user_division_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
  },
  (t) => [primaryKey({ columns: [t.userId, t.divisionCode] })],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §4.1 DIM_DIVISION — one row per division, with legacy codes as aliases
// ---------------------------------------------------------------------------

/**
 * §2 Rule 8: "Divisions live in a dimension table. ARG has restructured its
 * divisions twice already. Assume it happens again." No division code is
 * hardcoded anywhere in application logic — everything reads this table.
 *
 * `legacyCodes` carries BGI / CA,INV / PS - TP / PS - APS,PS - Other so the
 * balance-sheet tab's stale six-code scheme maps cleanly on load (Defect 1).
 */
export const dimDivision = pgTable('dim_division', {
  divisionCode: text('division_code').primaryKey(),
  divisionName: text('division_name').notNull(),
  lineOfBusiness: text('line_of_business').notNull(),
  legacyCodes: text('legacy_codes').array().notNull().default(sql`'{}'::text[]`),
  qboClassIds: text('qbo_class_ids').array().notNull().default(sql`'{}'::text[]`),
  primaryOperationalSystem: text('primary_operational_system'),
  sortOrder: integer('sort_order').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

// ---------------------------------------------------------------------------
// Period dimension — drives the open/closed label and the closed-month freeze
// ---------------------------------------------------------------------------

/**
 * §5.3: an open month refreshes nightly and must be labeled as open on the face
 * of every view; a closed month is frozen, and a later restatement creates a new
 * version rather than silently overwriting history.
 */
export const dimPeriod = pgTable('dim_period', {
  periodMonth: date('period_month').primaryKey(),
  fiscalYear: integer('fiscal_year').notNull(),
  /** §7: "months elapsed" is the month number — March = 3. */
  monthOfYear: integer('month_of_year').notNull(),
  /** §6 DSO/DPO: actual calendar days, not 30. */
  daysInMonth: integer('days_in_month').notNull(),
  isClosed: boolean('is_closed').notNull().default(false),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => users.id),
  restatementVersion: integer('restatement_version').notNull().default(1),
});

// ---------------------------------------------------------------------------
// Account dimension — the §5.1 "land the GL at account level" upgrade
// ---------------------------------------------------------------------------

/**
 * Westport's recommendation, accepted: land the full trial balance at account
 * level and roll up to the five reporting lines through this mapping. Buys
 * drill-down, a self-generating audit pack, and an agent that can answer "why
 * did OpEx jump in March?" rather than only "what was OpEx in March?".
 */
export const dimAccount = pgTable(
  'dim_account',
  {
    accountId: text('account_id').primaryKey(),
    accountNumber: text('account_number'),
    accountName: text('account_name').notNull(),
    accountType: glAccountType('account_type').notNull(),
    parentAccountId: text('parent_account_id'),
    /** NULL = unmapped. Loads fail loudly on unmapped accounts (Test 8). */
    reportingLine: reportingLine('reporting_line'),
    /** Balance-sheet grouping: cash | accounts_receivable | ... | shareholder_equity */
    balanceSheetLine: text('balance_sheet_line'),
    isActive: boolean('is_active').notNull().default(true),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dim_account_reporting_line_idx').on(t.reportingLine)],
);

/**
 * §6 Marketing: "CAC's numerator (sales and marketing) is a different set from
 * CPL's and ROAS's (marketing only). Get both account lists signed off by
 * Westport before you publish any of these four."
 *
 * Both sets are data, not code. Until an account carries the tag, the dependent
 * KPIs render as "pending definition" rather than computing on a guess.
 */
export const accountSpendTag = pgTable(
  'account_spend_tag',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => dimAccount.accountId, { onDelete: 'cascade' }),
    /** MARKETING_SPEND | SALES_AND_MARKETING_SPEND */
    tag: text('tag').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.tag] })],
);

// ---------------------------------------------------------------------------
// §4.2 FACT_PL_ACTUAL — grain: month × division
// ---------------------------------------------------------------------------

/**
 * Replaces the manual "Running P&L Rollup" tab — the one a human types into.
 *
 * payrollDirect and payrollExpense are MEMO ONLY. They are already inside cogs
 * and opex respectively and must never be subtracted separately. Getting this
 * wrong double-counts payroll and understates profit at every division, in every
 * month, on every dashboard. See the tie-out guard in tests/tieout.spec.ts:
 * SHRC gross profit is $71,451 — if you get $38,407 you subtracted the memo.
 */
export const factPlActual = pgTable(
  'fact_pl_actual',
  {
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    revenue: money('revenue').notNull().default('0'),
    payrollDirect: money('payroll_direct').notNull().default('0'),
    cogs: money('cogs').notNull().default('0'),
    payrollExpense: money('payroll_expense').notNull().default('0'),
    opex: money('opex').notNull().default('0'),
    basis: accountingBasis('basis').notNull().default('accrual'),
    sourceSystem: sourceSystem('source_system').notNull(),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.periodMonth, t.divisionCode] }),
    // §3: ARG Total is a rollup, never a row.
    check('fact_pl_actual_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
    index('fact_pl_actual_period_idx').on(t.periodMonth),
  ],
);

// ---------------------------------------------------------------------------
// §4.3 FACT_BS_ACTUAL — month-end balances. Drives DSO, DPO, CCC, Cash Runway
// ---------------------------------------------------------------------------

export const factBsActual = pgTable(
  'fact_bs_actual',
  {
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    cash: money('cash').notNull().default('0'),
    accountsReceivable: money('accounts_receivable').notNull().default('0'),
    otherCurrentAssets: money('other_current_assets').notNull().default('0'),
    fixedAssets: money('fixed_assets').notNull().default('0'),
    accountsPayable: money('accounts_payable').notNull().default('0'),
    ccLiability: money('cc_liability').notNull().default('0'),
    otherCurrentLiabilities: money('other_current_liabilities').notNull().default('0'),
    ltLiabilities: money('lt_liabilities').notNull().default('0'),
    /**
     * Defect 3: the workbook computes equity as assets minus liabilities, then
     * "checks" that assets equal liabilities plus equity — circular, returns zero
     * by construction, proves nothing. Load it from QBO as its own figure so the
     * balance check is a real assertion.
     */
    shareholderEquity: money('shareholder_equity').notNull().default('0'),
    basis: accountingBasis('basis').notNull().default('accrual'),
    sourceSystem: sourceSystem('source_system').notNull(),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.periodMonth, t.divisionCode] }),
    check('fact_bs_actual_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
  ],
);

/** A/R and A/P aging buckets — feeds the aging view and the DSO/DPO reconciliation. */
export const factAging = pgTable(
  'fact_aging',
  {
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    /** 'AR' | 'AP' */
    kind: text('kind').notNull(),
    /** 'current' | '1_30' | '31_60' | '61_90' | 'over_90' */
    bucket: text('bucket').notNull(),
    amount: money('amount').notNull().default('0'),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    primaryKey({ columns: [t.periodMonth, t.divisionCode, t.kind, t.bucket] }),
    check('fact_aging_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
  ],
);

/** Account-level trial balance (§5.1 upgrade). Rolls up to the five lines. */
export const factGlBalance = pgTable(
  'fact_gl_balance',
  {
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    accountId: text('account_id')
      .notNull()
      .references(() => dimAccount.accountId),
    amount: money('amount').notNull().default('0'),
    basis: accountingBasis('basis').notNull().default('accrual'),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    primaryKey({ columns: [t.periodMonth, t.divisionCode, t.accountId] }),
    check('fact_gl_balance_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
    index('fact_gl_period_division_idx').on(t.periodMonth, t.divisionCode),
  ],
);

// ---------------------------------------------------------------------------
// §4.4 FACT_BUDGET — month × division × scenario × line item
// ---------------------------------------------------------------------------

/**
 * 'MONTHLY_BUDGET' (FY2026 operating budget) and 'TENX' (10X growth plan,
 * 2026–2029) load today; a third scenario must not require a schema change, so
 * scenario_code is a plain text key rather than an enum.
 *
 * GP and NP are derived, never loaded — the workbook's GP and NP tables are
 * recomputed so the identity always holds.
 */
export const budgetScenario = pgTable('budget_scenario', {
  scenarioCode: text('scenario_code').primaryKey(),
  scenarioName: text('scenario_name').notNull(),
  description: text('description'),
  firstMonth: date('first_month').notNull(),
  lastMonth: date('last_month').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const factBudget = pgTable(
  'fact_budget',
  {
    scenarioCode: text('scenario_code')
      .notNull()
      .references(() => budgetScenario.scenarioCode),
    periodMonth: date('period_month').notNull(),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    lineItem: budgetLineItem('line_item').notNull(),
    amount: money('amount').notNull().default('0'),
    sourceSystem: sourceSystem('source_system').notNull(),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    primaryKey({ columns: [t.scenarioCode, t.periodMonth, t.divisionCode, t.lineItem] }),
    check('fact_budget_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
  ],
);

// ---------------------------------------------------------------------------
// §4.5 FACT_FORECAST — locked forecasts are accountability records
// ---------------------------------------------------------------------------

/**
 * A version per lock event. Named scenarios (base / upside / downside) live as
 * unlocked versions for the same month; exactly one is promoted to the official
 * locked forecast.
 *
 * Defect 4 / §10.3: a locked version can never be edited or deleted. A
 * correction creates a new version and both remain visible with a reason on the
 * record. Enforced by trigger `prevent_locked_forecast_mutation`, not by the UI.
 */
export const forecastVersion = pgTable(
  'forecast_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    scenarioName: text('scenario_name').notNull(),
    isOfficial: boolean('is_official').notNull().default(false),
    isLocked: boolean('is_locked').notNull().default(false),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: uuid('locked_by').references(() => users.id),
    /** Populated when this version corrects an earlier locked one. */
    supersedesVersionId: uuid('supersedes_version_id'),
    correctionReason: text('correction_reason'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('forecast_version_period_idx').on(t.periodMonth),
    // A locked version must carry who and when — an accountability record with
    // no attribution is not one.
    check(
      'forecast_version_lock_attributed',
      sql`(${t.isLocked} = false) OR (${t.lockedAt} IS NOT NULL AND ${t.lockedBy} IS NOT NULL)`,
    ),
  ],
);

export const factForecast = pgTable(
  'fact_forecast',
  {
    forecastVersionId: uuid('forecast_version_id')
      .notNull()
      .references(() => forecastVersion.id, { onDelete: 'cascade' }),
    periodMonth: date('period_month').notNull(),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),

    // --- The five assumptions the user enters (§10.1) ---
    assumRevenuePctOfBudget: numeric('assum_revenue_pct_of_budget', { precision: 12, scale: 6 })
      .notNull()
      .default('1'),
    assumPayrollDirectPct: numeric('assum_payroll_direct_pct', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    assumCogsPct: numeric('assum_cogs_pct', { precision: 12, scale: 6 }).notNull().default('0'),
    assumPayrollExpenseAmt: money('assum_payroll_expense_amt').notNull().default('0'),
    assumOpexAmt: money('assum_opex_amt').notNull().default('0'),

    // --- Computed and stored at lock time. All five populated, always.
    // Defect 4: in the Excel the FC Gross Profit column has never been
    // populated in any row, which gates off every gross-profit variance column.
    fcRevenue: money('fc_revenue').notNull().default('0'),
    fcPayrollDirect: money('fc_payroll_direct').notNull().default('0'),
    fcCogs: money('fc_cogs').notNull().default('0'),
    fcGrossProfit: money('fc_gross_profit').notNull().default('0'),
    fcPayrollExpense: money('fc_payroll_expense').notNull().default('0'),
    fcOpex: money('fc_opex').notNull().default('0'),
    fcNetProfit: money('fc_net_profit').notNull().default('0'),

    /** Denormalised from the version so the trigger can guard row-level writes. */
    isLocked: boolean('is_locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.forecastVersionId, t.periodMonth, t.divisionCode] }),
    check('fact_forecast_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
  ],
);

/**
 * Defect 4 / §10.3: "Block entry of a month's actuals until that month's
 * forecast is locked, or the lock is explicitly waived with a captured reason."
 * The waiver is a record, not a checkbox.
 */
export const forecastLockWaiver = pgTable('forecast_lock_waiver', {
  id: uuid('id').primaryKey().defaultRandom(),
  periodMonth: date('period_month')
    .notNull()
    .references(() => dimPeriod.periodMonth),
  reason: text('reason').notNull(),
  waivedBy: uuid('waived_by')
    .notNull()
    .references(() => users.id),
  waivedAt: timestamp('waived_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §4.6 HubSpot facts — landed at natural grain, never pre-aggregated
// ---------------------------------------------------------------------------

/**
 * "Do not pre-aggregate on load — ARG will want to slice these by owner, source
 * and pipeline stage."
 *
 * divisionCode is nullable on purpose. §4.6: "Before you build them, confirm
 * with Westport how a HubSpot deal is attributed to a division... If no reliable
 * attribution exists, sales and marketing KPIs report at ARG Total only in
 * Phase 1. Do not invent an attribution rule." A null here means exactly that,
 * and the KPI layer reports at ARG Total rather than guessing.
 */
export const factDeal = pgTable(
  'fact_deal',
  {
    dealId: text('deal_id').primaryKey(),
    divisionCode: text('division_code').references(() => dimDivision.divisionCode),
    dealName: text('deal_name'),
    amount: money('amount').notNull().default('0'),
    dealstage: text('dealstage'),
    pipeline: text('pipeline'),
    isClosedWon: boolean('is_closed_won').notNull().default(false),
    isClosed: boolean('is_closed').notNull().default(false),
    createdate: timestamp('createdate', { withTimezone: true }),
    closedate: timestamp('closedate', { withTimezone: true }),
    /** §6 Sales: from stage history, not current stage. */
    enteredProposalAt: timestamp('entered_proposal_at', { withTimezone: true }),
    ownerId: text('owner_id'),
    contactId: text('contact_id'),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    index('fact_deal_closedate_idx').on(t.closedate),
    index('fact_deal_division_idx').on(t.divisionCode),
  ],
);

/** §5.2: required for New Proposals Sent — the timestamp a deal entered a stage. */
export const factDealStageHistory = pgTable(
  'fact_deal_stage_history',
  {
    dealId: text('deal_id')
      .notNull()
      .references(() => factDeal.dealId, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull(),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    primaryKey({ columns: [t.dealId, t.stage, t.enteredAt] }),
    index('fact_deal_stage_entered_idx').on(t.stage, t.enteredAt),
  ],
);

export const factContact = pgTable(
  'fact_contact',
  {
    contactId: text('contact_id').primaryKey(),
    divisionCode: text('division_code').references(() => dimDivision.divisionCode),
    lifecycleStage: text('lifecycle_stage'),
    originalSource: text('original_source'),
    createdate: timestamp('createdate', { withTimezone: true }),
    /** §6 Marketing: leads counted by the date the contact became a lead. */
    becameLeadDate: timestamp('became_lead_date', { withTimezone: true }),
    becameCustomerDate: timestamp('became_customer_date', { withTimezone: true }),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [index('fact_contact_lead_date_idx').on(t.becameLeadDate)],
);

export const factMeeting = pgTable(
  'fact_meeting',
  {
    meetingId: text('meeting_id').primaryKey(),
    divisionCode: text('division_code').references(() => dimDivision.divisionCode),
    meetingDate: timestamp('meeting_date', { withTimezone: true }).notNull(),
    outcome: text('outcome'),
    ownerId: text('owner_id'),
    associatedDealId: text('associated_deal_id'),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [index('fact_meeting_date_idx').on(t.meetingDate)],
);

/** §6 Operations: headcount arrives monthly. Sheets import or file upload. */
export const factHeadcount = pgTable(
  'fact_headcount',
  {
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code')
      .notNull()
      .references(() => dimDivision.divisionCode),
    headcount: numeric('headcount', { precision: 10, scale: 2 }).notNull(),
    sourceSystem: sourceSystem('source_system').notNull(),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
  },
  (t) => [
    primaryKey({ columns: [t.periodMonth, t.divisionCode] }),
    check('fact_headcount_no_total', sql`${t.divisionCode} <> 'ARG_TOTAL'`),
  ],
);

// ---------------------------------------------------------------------------
// Load provenance — every load timestamped, reproducible and reversible
// ---------------------------------------------------------------------------

/**
 * §1 Layer 2: "Every load timestamped and reproducible."
 *
 * One agent extraction maps to exactly one load_run, which can be rolled back.
 * The agent previews a run (status PREVIEW) and writes nothing until a human
 * confirms.
 */
export const loadRun = pgTable(
  'load_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSystem: sourceSystem('source_system').notNull(),
    entity: text('entity').notNull(),
    windowStart: date('window_start'),
    windowEnd: date('window_end'),
    status: loadRunStatus('status').notNull().default('PENDING'),
    /** Set when an agent proposed this run; null for scheduled refreshes. */
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
    agentConversationId: uuid('agent_conversation_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    rowsRead: integer('rows_read').notNull().default(0),
    rowsWritten: integer('rows_written').notNull().default(0),
    /** Snapshot of replaced rows so a run can be reversed exactly. */
    reversalSnapshot: jsonb('reversal_snapshot'),
    plan: jsonb('plan'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('load_run_started_idx').on(t.startedAt)],
);

/** Raw landing. Conform reads from here, so a reload never re-hits the API. */
export const rawPayload = pgTable(
  'raw_payload',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loadRunId: uuid('load_run_id')
      .notNull()
      .references(() => loadRun.id, { onDelete: 'cascade' }),
    sourceSystem: sourceSystem('source_system').notNull(),
    entity: text('entity').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('raw_payload_run_idx').on(t.loadRunId)],
);

// ---------------------------------------------------------------------------
// Reconciliation controls (§2 Rule 1, §13 tests 1–4)
// ---------------------------------------------------------------------------

/**
 * "Build these as standing automated checks that run on every refresh and
 * surface a visible pass/fail — not as one-time validations you run by hand at
 * go-live."
 */
export const reconResult = pgTable(
  'recon_result',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkId: text('check_id').notNull(),
    checkName: text('check_name').notNull(),
    periodMonth: date('period_month'),
    divisionCode: text('division_code'),
    status: reconStatus('status').notNull(),
    expected: money('expected'),
    actual: money('actual'),
    variance: money('variance'),
    /** §2 Rule 2: rounding and timing are valid. "Unknown" is not. */
    detail: text('detail'),
    loadRunId: uuid('load_run_id').references(() => loadRun.id),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recon_result_ran_idx').on(t.ranAt), index('recon_result_check_idx').on(t.checkId)],
);

/** A failing check needs a human explanation. The form rejects "unknown". */
export const varianceExplanation = pgTable('variance_explanation', {
  id: uuid('id').primaryKey().defaultRandom(),
  reconResultId: uuid('recon_result_id')
    .notNull()
    .references(() => reconResult.id, { onDelete: 'cascade' }),
  /** 'ROUNDING' | 'TIMING' | 'SOURCE_CORRECTION' | 'MAPPING' */
  category: text('category').notNull(),
  explanation: text('explanation').notNull(),
  explainedBy: uuid('explained_by')
    .notNull()
    .references(() => users.id),
  explainedAt: timestamp('explained_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Agent layer
// ---------------------------------------------------------------------------

export const agentConversation = pgTable('agent_conversation', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  /** The page and filters the agent was invoked from. */
  pageContext: jsonb('page_context'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §11 Requirement 6: "Log every question and answer. Westport reviews the log
 * during the audit pass." Every prompt, tool call, view spec and result lands
 * here — including refusals, which are the most useful rows in the table.
 */
export const aiQueryLog = pgTable(
  'ai_query_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').references(() => agentConversation.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id),
    role: text('role').notNull(), // user | assistant | tool
    content: text('content'),
    toolName: text('tool_name'),
    toolInput: jsonb('tool_input'),
    toolOutput: jsonb('tool_output'),
    /** True when the assistant declined rather than estimating (§11 req 3). */
    wasRefusal: boolean('was_refusal').notNull().default(false),
    citations: jsonb('citations'),
    model: text('model'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_query_log_created_idx').on(t.createdAt)],
);

/**
 * A generated chart or table. Stores the validated view spec, never rendered
 * markup and never the numbers — re-executing the spec through resolveKpi is
 * what guarantees a pinned view can never drift from the dashboards.
 */
export const generatedView = pgTable('generated_view', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => agentConversation.id, {
    onDelete: 'set null',
  }),
  title: text('title').notNull(),
  spec: jsonb('spec').notNull(),
  /** Pinned views appear on the named dashboard for their owner. */
  pinnedTo: text('pinned_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Named standing goals the agent evaluates on refresh and on close. */
export const agentGoal = pgTable('agent_goal', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** What the owner wrote. Quoted back in findings; never interpreted as logic. */
  instruction: text('instruction').notNull(),
  /**
   * The built-in rule that actually runs, from `lib/ai/goals.ts`.
   *
   * Goals evaluate in TypeScript against `resolveKpi`, not by handing the
   * instruction text to a model each night. An exception that lands on the CEO's
   * dashboard has to fire for the same reason every time.
   */
  evaluator: text('evaluator').notNull(),
  params: jsonb('params'),
  /** 'ON_REFRESH' | 'ON_CLOSE' | 'MONTHLY' */
  cadence: text('cadence').notNull().default('ON_REFRESH'),
  isActive: boolean('is_active').notNull().default(true),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** What a goal evaluation found. Feeds the Executive exception panel. */
export const agentFinding = pgTable(
  'agent_finding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goalId: uuid('goal_id').references(() => agentGoal.id, { onDelete: 'cascade' }),
    periodMonth: date('period_month'),
    divisionCode: text('division_code'),
    /** 'good' | 'warning' | 'serious' | 'critical' */
    severity: text('severity').notNull(),
    headline: text('headline').notNull(),
    detail: text('detail'),
    citations: jsonb('citations'),
    isAcknowledged: boolean('is_acknowledged').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_finding_created_idx').on(t.createdAt)],
);

/** Excel/CSV staged for agent column-mapping. Committed only after a diff review. */
export const uploadFile = pgTable('upload_file', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  /** Parsed sheet -> rows, before any mapping is applied. */
  parsed: jsonb('parsed'),
  /** Agent's proposed column -> field mapping, shown to the user as a diff. */
  proposedMapping: jsonb('proposed_mapping'),
  status: text('status').notNull().default('PARSED'),
  loadRunId: uuid('load_run_id').references(() => loadRun.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Monthly close narrative drafted by the agent, edited and signed by Westport. */
export const monthlyCommentary = pgTable(
  'monthly_commentary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodMonth: date('period_month')
      .notNull()
      .references(() => dimPeriod.periodMonth),
    divisionCode: text('division_code'),
    draft: text('draft').notNull(),
    edited: text('edited'),
    signedBy: uuid('signed_by').references(() => users.id),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    citations: jsonb('citations'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('monthly_commentary_key').on(t.periodMonth, t.divisionCode)],
);

// ---------------------------------------------------------------------------
// Audit + configuration
// ---------------------------------------------------------------------------

export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_event_created_idx').on(t.createdAt)],
);

/**
 * Open items that are Westport decisions, not developer guesses (§14.3). They
 * live as data and are visible in the admin area rather than silently assumed.
 * e.g. BALANCE_SHEET_CLASSED, HUBSPOT_DIVISION_ATTRIBUTION.
 */
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value'),
  description: text('description'),
  /** When false the dependent surfaces render "pending definition". */
  isConfirmed: boolean('is_confirmed').notNull().default(false),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
