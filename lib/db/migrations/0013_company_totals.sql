-- QuickBooks' own company-level totals, and a balance sheet that balances.
--
-- ARG Total is the sum of the four divisions, which is right for the P&L and
-- wrong for the balance sheet. ARG's classed balance sheet does not balance by
-- class — in January 2026 CLAIMS showed $423,633 of assets against $941,813 of
-- liabilities and equity, "Not Specified" held $849,359 of assets and "Z Alloc"
-- held -$2,159,621 of liabilities and equity. Only QuickBooks' TOTAL column is a
-- balance sheet. This table holds that column (and the P&L's, as a tie-out) so
-- the Finance page can show a real balance sheet and working capital and can
-- state whether its P&L agrees with QuickBooks to the dollar.

CREATE TABLE IF NOT EXISTS "fact_company_total" (
  "period_month" date NOT NULL REFERENCES "dim_period"("period_month"),
  "statement" text NOT NULL,
  "line" text NOT NULL,
  "amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "source_system" "source_system" NOT NULL,
  "load_run_id" uuid REFERENCES "load_run"("id"),
  "loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fact_company_total_pk" PRIMARY KEY ("period_month", "statement", "line")
);
--> statement-breakpoint

-- Open item 1, answered by the data: ARG does not class its balance sheet in a
-- way that can be read by division. The balance-sheet metrics report at ARG Total
-- from the company balance sheet, and say so at division level, rather than show
-- a per-division balance sheet that does not balance.
UPDATE "app_config"
SET "value" = 'false',
    "description" = 'Open item 1 — does ARG class its balance sheet in QBO? Answered from ARG''s own books in September 2026: no. The classed balance sheet does not balance by class (most balances sit on Not Specified and Z Alloc), so DSO, DPO, CCC, Cash Runway and working capital come from the company balance sheet at ARG Total and are labelled unavailable by division.',
    "updated_at" = now()
WHERE "key" = 'BALANCE_SHEET_CLASSED';
--> statement-breakpoint

-- Future-dated QuickBooks months, loaded by a pull whose window ran to December.
-- QuickBooks answers a month that has not happened with whatever is already
-- dated into it (a recurring entry, a prepaid bill), which produced one- and
-- two-division "P&Ls" for October to December 2026 and failed three
-- reconciliation checks. The pull no longer reaches past the current month; the
-- rows it already wrote are removed. Anything real re-loads on the next pull of
-- that month once it has begun.
DELETE FROM "fact_gl_balance"
WHERE "period_month" > date_trunc('month', now())::date
  AND "load_run_id" IN (SELECT "id" FROM "load_run" WHERE "source_system" = 'QBO');
--> statement-breakpoint
DELETE FROM "fact_pl_actual"
WHERE "period_month" > date_trunc('month', now())::date
  AND "source_system" = 'QBO';
