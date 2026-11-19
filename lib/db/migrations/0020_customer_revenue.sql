-- Revenue by customer and business line.
--
-- Westport, November 2026: "In order to determine a sales/revenue # we are
-- trying to determine how much revenue will come from existing clients vs. net
-- new … some type of visual indicator by business line to track net new vs.
-- existing client growth." From QuickBooks' Income by Customer report, one
-- month and one class at a time (class_key 'ALL' is the unfiltered company
-- report). Accrual basis, as the P&L.

CREATE TABLE IF NOT EXISTS "fact_customer_revenue" (
  "period_month" date NOT NULL,
  "class_key" text NOT NULL,
  "class_name" text,
  "division_code" text,
  "customer_id" text NOT NULL,
  "customer_name" text,
  "income" numeric(18, 2) NOT NULL DEFAULT 0,
  "load_run_id" uuid REFERENCES "load_run"("id"),
  CONSTRAINT "fact_customer_revenue_pk" PRIMARY KEY ("period_month", "class_key", "customer_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_customer_revenue_customer_idx" ON "fact_customer_revenue" ("customer_id", "period_month");
