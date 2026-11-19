-- Booked against billed, account by account.
--
-- Westport, November 2026: "Ideally we want to be able to determine which
-- accounts have started billing in QuickBooks compared to what is closed/won",
-- and "if an account has gone live and we anticipate it billing $100K for the
-- 12 month period, we would like live reporting of progress".
--
-- Until now QuickBooks revenue was landed by class (division) only, so no
-- figure in the warehouse could say what one customer had been billed.
--
-- dim_qbo_customer
--   QuickBooks' customer list, with the parent of a sub-customer (a job) so a
--   customer's billing includes its jobs, and the email and website domains
--   that let a HubSpot company be matched to it by something firmer than name.
--
-- fact_invoice
--   Invoices and credit memos, one row each: who, when, and the amount billed
--   (total less sales tax; a credit memo negative). Only the columns the
--   comparison reads are fetched — not the line items.
--
-- map_company_customer
--   Which QuickBooks customer a HubSpot company is, when a person has said so.
--   The dashboard suggests a match by domain or exact name and counts it, but a
--   suggestion is never stored as a decision: Westport confirms, changes or
--   rejects it in Admin, and that decision is what is kept here.

CREATE TABLE IF NOT EXISTS "dim_qbo_customer" (
  "customer_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "company_name" text,
  "fully_qualified_name" text,
  "parent_id" text,
  "email_domain" text,
  "web_domain" text,
  "active" boolean DEFAULT true NOT NULL,
  "load_run_id" uuid REFERENCES "load_run"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fact_invoice" (
  "invoice_key" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "doc_number" text,
  "customer_id" text NOT NULL,
  "customer_name" text,
  "txn_date" date NOT NULL,
  "total" numeric(18, 4) DEFAULT '0' NOT NULL,
  "tax" numeric(18, 4) DEFAULT '0' NOT NULL,
  "billed" numeric(18, 4) DEFAULT '0' NOT NULL,
  "balance" numeric(18, 4) DEFAULT '0' NOT NULL,
  "last_updated" timestamp with time zone,
  "load_run_id" uuid REFERENCES "load_run"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_invoice_customer_idx" ON "fact_invoice" ("customer_id", "txn_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_company_customer" (
  "company_id" text PRIMARY KEY NOT NULL,
  "qbo_customer_id" text,
  "decided_by_user_id" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
