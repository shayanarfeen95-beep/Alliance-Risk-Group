CREATE TYPE "public"."accounting_basis" AS ENUM('accrual', 'cash');--> statement-breakpoint
CREATE TYPE "public"."budget_line_item" AS ENUM('revenue', 'cogs', 'opex');--> statement-breakpoint
CREATE TYPE "public"."gl_account_type" AS ENUM('INCOME', 'COGS', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY');--> statement-breakpoint
CREATE TYPE "public"."load_run_status" AS ENUM('PENDING', 'PREVIEW', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TYPE "public"."recon_status" AS ENUM('PASS', 'FAIL', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TYPE "public"."reporting_line" AS ENUM('revenue', 'payroll_direct', 'cogs', 'payroll_expense', 'opex');--> statement-breakpoint
CREATE TYPE "public"."source_system" AS ENUM('QBO', 'HUBSPOT', 'SHEETS', 'UPLOAD', 'MANUAL', 'SEED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'CFO', 'EXECUTIVE', 'DIVISION_MANAGER', 'VIEWER');--> statement-breakpoint
CREATE TABLE "account_spend_tag" (
	"account_id" text NOT NULL,
	"tag" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	CONSTRAINT "account_spend_tag_account_id_tag_pk" PRIMARY KEY("account_id","tag")
);
--> statement-breakpoint
CREATE TABLE "agent_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"page_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid,
	"period_month" date,
	"division_code" text,
	"severity" text NOT NULL,
	"headline" text NOT NULL,
	"detail" text,
	"citations" jsonb,
	"is_acknowledged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"cadence" text DEFAULT 'ON_REFRESH' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_query_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"user_id" uuid,
	"role" text NOT NULL,
	"content" text,
	"tool_name" text,
	"tool_input" jsonb,
	"tool_output" jsonb,
	"was_refusal" boolean DEFAULT false NOT NULL,
	"citations" jsonb,
	"model" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"description" text,
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_scenario" (
	"scenario_code" text PRIMARY KEY NOT NULL,
	"scenario_name" text NOT NULL,
	"description" text,
	"first_month" date NOT NULL,
	"last_month" date NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dim_account" (
	"account_id" text PRIMARY KEY NOT NULL,
	"account_number" text,
	"account_name" text NOT NULL,
	"account_type" "gl_account_type" NOT NULL,
	"parent_account_id" text,
	"reporting_line" "reporting_line",
	"balance_sheet_line" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dim_division" (
	"division_code" text PRIMARY KEY NOT NULL,
	"division_name" text NOT NULL,
	"line_of_business" text NOT NULL,
	"legacy_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"qbo_class_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"primary_operational_system" text,
	"sort_order" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dim_period" (
	"period_month" date PRIMARY KEY NOT NULL,
	"fiscal_year" integer NOT NULL,
	"month_of_year" integer NOT NULL,
	"days_in_month" integer NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"restatement_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_aging" (
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"kind" text NOT NULL,
	"bucket" text NOT NULL,
	"amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"load_run_id" uuid,
	CONSTRAINT "fact_aging_period_month_division_code_kind_bucket_pk" PRIMARY KEY("period_month","division_code","kind","bucket"),
	CONSTRAINT "fact_aging_no_total" CHECK ("fact_aging"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_bs_actual" (
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"cash" numeric(18, 4) DEFAULT '0' NOT NULL,
	"accounts_receivable" numeric(18, 4) DEFAULT '0' NOT NULL,
	"other_current_assets" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fixed_assets" numeric(18, 4) DEFAULT '0' NOT NULL,
	"accounts_payable" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cc_liability" numeric(18, 4) DEFAULT '0' NOT NULL,
	"other_current_liabilities" numeric(18, 4) DEFAULT '0' NOT NULL,
	"lt_liabilities" numeric(18, 4) DEFAULT '0' NOT NULL,
	"shareholder_equity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"basis" "accounting_basis" DEFAULT 'accrual' NOT NULL,
	"source_system" "source_system" NOT NULL,
	"load_run_id" uuid,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_bs_actual_period_month_division_code_pk" PRIMARY KEY("period_month","division_code"),
	CONSTRAINT "fact_bs_actual_no_total" CHECK ("fact_bs_actual"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_budget" (
	"scenario_code" text NOT NULL,
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"line_item" "budget_line_item" NOT NULL,
	"amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"source_system" "source_system" NOT NULL,
	"load_run_id" uuid,
	CONSTRAINT "fact_budget_scenario_code_period_month_division_code_line_item_pk" PRIMARY KEY("scenario_code","period_month","division_code","line_item"),
	CONSTRAINT "fact_budget_no_total" CHECK ("fact_budget"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_contact" (
	"contact_id" text PRIMARY KEY NOT NULL,
	"division_code" text,
	"lifecycle_stage" text,
	"original_source" text,
	"createdate" timestamp with time zone,
	"became_lead_date" timestamp with time zone,
	"became_customer_date" timestamp with time zone,
	"load_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fact_deal" (
	"deal_id" text PRIMARY KEY NOT NULL,
	"division_code" text,
	"deal_name" text,
	"amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"dealstage" text,
	"pipeline" text,
	"is_closed_won" boolean DEFAULT false NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"createdate" timestamp with time zone,
	"closedate" timestamp with time zone,
	"entered_proposal_at" timestamp with time zone,
	"owner_id" text,
	"contact_id" text,
	"load_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fact_deal_stage_history" (
	"deal_id" text NOT NULL,
	"stage" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"load_run_id" uuid,
	CONSTRAINT "fact_deal_stage_history_deal_id_stage_entered_at_pk" PRIMARY KEY("deal_id","stage","entered_at")
);
--> statement-breakpoint
CREATE TABLE "fact_forecast" (
	"forecast_version_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"assum_revenue_pct_of_budget" numeric(12, 6) DEFAULT '1' NOT NULL,
	"assum_payroll_direct_pct" numeric(12, 6) DEFAULT '0' NOT NULL,
	"assum_cogs_pct" numeric(12, 6) DEFAULT '0' NOT NULL,
	"assum_payroll_expense_amt" numeric(18, 4) DEFAULT '0' NOT NULL,
	"assum_opex_amt" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_revenue" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_payroll_direct" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_cogs" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_gross_profit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_payroll_expense" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_opex" numeric(18, 4) DEFAULT '0' NOT NULL,
	"fc_net_profit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_forecast_forecast_version_id_period_month_division_code_pk" PRIMARY KEY("forecast_version_id","period_month","division_code"),
	CONSTRAINT "fact_forecast_no_total" CHECK ("fact_forecast"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_gl_balance" (
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"account_id" text NOT NULL,
	"amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"basis" "accounting_basis" DEFAULT 'accrual' NOT NULL,
	"load_run_id" uuid,
	CONSTRAINT "fact_gl_balance_period_month_division_code_account_id_pk" PRIMARY KEY("period_month","division_code","account_id"),
	CONSTRAINT "fact_gl_balance_no_total" CHECK ("fact_gl_balance"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_headcount" (
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"headcount" numeric(10, 2) NOT NULL,
	"source_system" "source_system" NOT NULL,
	"load_run_id" uuid,
	CONSTRAINT "fact_headcount_period_month_division_code_pk" PRIMARY KEY("period_month","division_code"),
	CONSTRAINT "fact_headcount_no_total" CHECK ("fact_headcount"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "fact_meeting" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"division_code" text,
	"meeting_date" timestamp with time zone NOT NULL,
	"outcome" text,
	"owner_id" text,
	"associated_deal_id" text,
	"load_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fact_pl_actual" (
	"period_month" date NOT NULL,
	"division_code" text NOT NULL,
	"revenue" numeric(18, 4) DEFAULT '0' NOT NULL,
	"payroll_direct" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cogs" numeric(18, 4) DEFAULT '0' NOT NULL,
	"payroll_expense" numeric(18, 4) DEFAULT '0' NOT NULL,
	"opex" numeric(18, 4) DEFAULT '0' NOT NULL,
	"basis" "accounting_basis" DEFAULT 'accrual' NOT NULL,
	"source_system" "source_system" NOT NULL,
	"load_run_id" uuid,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_pl_actual_period_month_division_code_pk" PRIMARY KEY("period_month","division_code"),
	CONSTRAINT "fact_pl_actual_no_total" CHECK ("fact_pl_actual"."division_code" <> 'ARG_TOTAL')
);
--> statement-breakpoint
CREATE TABLE "forecast_lock_waiver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" date NOT NULL,
	"reason" text NOT NULL,
	"waived_by" uuid NOT NULL,
	"waived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" date NOT NULL,
	"scenario_name" text NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"supersedes_version_id" uuid,
	"correction_reason" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_version_lock_attributed" CHECK (("forecast_version"."is_locked" = false) OR ("forecast_version"."locked_at" IS NOT NULL AND "forecast_version"."locked_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "generated_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"title" text NOT NULL,
	"spec" jsonb NOT NULL,
	"pinned_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "load_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" "source_system" NOT NULL,
	"entity" text NOT NULL,
	"window_start" date,
	"window_end" date,
	"status" "load_run_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by_user_id" uuid,
	"agent_conversation_id" uuid,
	"confirmed_at" timestamp with time zone,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"reversal_snapshot" jsonb,
	"plan" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monthly_commentary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" date NOT NULL,
	"division_code" text,
	"draft" text NOT NULL,
	"edited" text,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_payload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"load_run_id" uuid NOT NULL,
	"source_system" "source_system" NOT NULL,
	"entity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" text NOT NULL,
	"check_name" text NOT NULL,
	"period_month" date,
	"division_code" text,
	"status" "recon_status" NOT NULL,
	"expected" numeric(18, 4),
	"actual" numeric(18, 4),
	"variance" numeric(18, 4),
	"detail" text,
	"load_run_id" uuid,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"parsed" jsonb,
	"proposed_mapping" jsonb,
	"status" text DEFAULT 'PARSED' NOT NULL,
	"load_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_division_access" (
	"user_id" uuid NOT NULL,
	"division_code" text NOT NULL,
	CONSTRAINT "user_division_access_user_id_division_code_pk" PRIMARY KEY("user_id","division_code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"can_view_consolidated" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variance_explanation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recon_result_id" uuid NOT NULL,
	"category" text NOT NULL,
	"explanation" text NOT NULL,
	"explained_by" uuid NOT NULL,
	"explained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_spend_tag" ADD CONSTRAINT "account_spend_tag_account_id_dim_account_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dim_account"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_finding" ADD CONSTRAINT "agent_finding_goal_id_agent_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."agent_goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_goal" ADD CONSTRAINT "agent_goal_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_conversation_id_agent_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_query_log" ADD CONSTRAINT "ai_query_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dim_period" ADD CONSTRAINT "dim_period_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_aging" ADD CONSTRAINT "fact_aging_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_aging" ADD CONSTRAINT "fact_aging_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_aging" ADD CONSTRAINT "fact_aging_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_bs_actual" ADD CONSTRAINT "fact_bs_actual_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_bs_actual" ADD CONSTRAINT "fact_bs_actual_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_bs_actual" ADD CONSTRAINT "fact_bs_actual_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_budget" ADD CONSTRAINT "fact_budget_scenario_code_budget_scenario_scenario_code_fk" FOREIGN KEY ("scenario_code") REFERENCES "public"."budget_scenario"("scenario_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_budget" ADD CONSTRAINT "fact_budget_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_budget" ADD CONSTRAINT "fact_budget_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_contact" ADD CONSTRAINT "fact_contact_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_contact" ADD CONSTRAINT "fact_contact_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_deal" ADD CONSTRAINT "fact_deal_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_deal" ADD CONSTRAINT "fact_deal_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_deal_stage_history" ADD CONSTRAINT "fact_deal_stage_history_deal_id_fact_deal_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."fact_deal"("deal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_deal_stage_history" ADD CONSTRAINT "fact_deal_stage_history_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_forecast" ADD CONSTRAINT "fact_forecast_forecast_version_id_forecast_version_id_fk" FOREIGN KEY ("forecast_version_id") REFERENCES "public"."forecast_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_forecast" ADD CONSTRAINT "fact_forecast_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_gl_balance" ADD CONSTRAINT "fact_gl_balance_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_gl_balance" ADD CONSTRAINT "fact_gl_balance_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_gl_balance" ADD CONSTRAINT "fact_gl_balance_account_id_dim_account_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dim_account"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_gl_balance" ADD CONSTRAINT "fact_gl_balance_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_headcount" ADD CONSTRAINT "fact_headcount_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_headcount" ADD CONSTRAINT "fact_headcount_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_headcount" ADD CONSTRAINT "fact_headcount_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_meeting" ADD CONSTRAINT "fact_meeting_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_meeting" ADD CONSTRAINT "fact_meeting_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_pl_actual" ADD CONSTRAINT "fact_pl_actual_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_pl_actual" ADD CONSTRAINT "fact_pl_actual_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_pl_actual" ADD CONSTRAINT "fact_pl_actual_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_lock_waiver" ADD CONSTRAINT "forecast_lock_waiver_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_lock_waiver" ADD CONSTRAINT "forecast_lock_waiver_waived_by_users_id_fk" FOREIGN KEY ("waived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_version" ADD CONSTRAINT "forecast_version_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_version" ADD CONSTRAINT "forecast_version_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_version" ADD CONSTRAINT "forecast_version_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_view" ADD CONSTRAINT "generated_view_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_view" ADD CONSTRAINT "generated_view_conversation_id_agent_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_run" ADD CONSTRAINT "load_run_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_commentary" ADD CONSTRAINT "monthly_commentary_period_month_dim_period_period_month_fk" FOREIGN KEY ("period_month") REFERENCES "public"."dim_period"("period_month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_commentary" ADD CONSTRAINT "monthly_commentary_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_payload" ADD CONSTRAINT "raw_payload_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_result" ADD CONSTRAINT "recon_result_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_file" ADD CONSTRAINT "upload_file_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_file" ADD CONSTRAINT "upload_file_load_run_id_load_run_id_fk" FOREIGN KEY ("load_run_id") REFERENCES "public"."load_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_division_access" ADD CONSTRAINT "user_division_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_division_access" ADD CONSTRAINT "user_division_access_division_code_dim_division_division_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."dim_division"("division_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variance_explanation" ADD CONSTRAINT "variance_explanation_recon_result_id_recon_result_id_fk" FOREIGN KEY ("recon_result_id") REFERENCES "public"."recon_result"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variance_explanation" ADD CONSTRAINT "variance_explanation_explained_by_users_id_fk" FOREIGN KEY ("explained_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_finding_created_idx" ON "agent_finding" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_query_log_created_idx" ON "ai_query_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_event_created_idx" ON "audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dim_account_reporting_line_idx" ON "dim_account" USING btree ("reporting_line");--> statement-breakpoint
CREATE INDEX "fact_contact_lead_date_idx" ON "fact_contact" USING btree ("became_lead_date");--> statement-breakpoint
CREATE INDEX "fact_deal_closedate_idx" ON "fact_deal" USING btree ("closedate");--> statement-breakpoint
CREATE INDEX "fact_deal_division_idx" ON "fact_deal" USING btree ("division_code");--> statement-breakpoint
CREATE INDEX "fact_deal_stage_entered_idx" ON "fact_deal_stage_history" USING btree ("stage","entered_at");--> statement-breakpoint
CREATE INDEX "fact_gl_period_division_idx" ON "fact_gl_balance" USING btree ("period_month","division_code");--> statement-breakpoint
CREATE INDEX "fact_meeting_date_idx" ON "fact_meeting" USING btree ("meeting_date");--> statement-breakpoint
CREATE INDEX "fact_pl_actual_period_idx" ON "fact_pl_actual" USING btree ("period_month");--> statement-breakpoint
CREATE INDEX "forecast_version_period_idx" ON "forecast_version" USING btree ("period_month");--> statement-breakpoint
CREATE INDEX "load_run_started_idx" ON "load_run" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_commentary_key" ON "monthly_commentary" USING btree ("period_month","division_code");--> statement-breakpoint
CREATE INDEX "raw_payload_run_idx" ON "raw_payload" USING btree ("load_run_id");--> statement-breakpoint
CREATE INDEX "recon_result_ran_idx" ON "recon_result" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX "recon_result_check_idx" ON "recon_result" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));