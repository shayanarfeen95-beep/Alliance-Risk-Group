-- What the Leadership 2026 review needs that the warehouse could not express.
--
-- Four additions, each closing a specific gap found by reading ARG's own portal
-- rather than by assuming HubSpot's defaults.
--
-- dim_deal_stage
--   Stage ids are opaque and portal-specific. ARG's "Proposal" stage has the id
--   `presentationscheduled` and its "Compliance Review" stage is `1383067404`.
--   Code that recognised a stage by matching words against its id therefore
--   matched nothing: New Proposals Sent was null for every live deal while
--   looking healthy on seeded data, where the ids happen to read like words.
--   Labels are now reference data and everything downstream matches on those.
--
-- fact_contact.became_mql_date / became_sql_date
--   HubSpot documents hs_lifecyclestage_marketingqualifiedlead_date and its
--   siblings, and in ARG's portal every one of them is empty — checked across a
--   hundred contacts. Only `lifecyclestage` itself carries a value, so the date
--   a contact qualified exists only in that property's HISTORY. That is where
--   these are derived from. It is also why leads-by-month has been empty:
--   became_lead_date was reading the same absent field.
--
-- fact_deal.deal_type
--   HubSpot's newbusiness / existingbusiness. The "new business" filter
--   leadership asked for, and the distinction the booked-versus-actual
--   comparison depends on — booked and billed mean different things for a new
--   logo and for a renewal.
--
-- fact_company + fact_deal.company_id
--   Ideal Customer Profile Tier lives on the company, not the deal, so average
--   deal size by ICP cannot be answered without it. The association is also the
--   only honest way to line a HubSpot booking up against QuickBooks revenue.
--
-- Every column is nullable and unbackfilled. Existing rows read as null until
-- the next pull, which is true: the previous load did not fetch them.

ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "deal_type" text;
--> statement-breakpoint
ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "company_id" text;
--> statement-breakpoint
ALTER TABLE "fact_contact" ADD COLUMN IF NOT EXISTS "became_mql_date" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fact_contact" ADD COLUMN IF NOT EXISTS "became_sql_date" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dim_deal_stage" (
  "stage_id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "pipeline_id" text NOT NULL,
  "pipeline_label" text NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "is_closed" boolean DEFAULT false NOT NULL,
  "is_won" boolean DEFAULT false NOT NULL,
  "load_run_id" uuid REFERENCES "load_run"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fact_company" (
  "company_id" text PRIMARY KEY NOT NULL,
  "name" text,
  "icp_tier" text,
  "domain" text,
  "division_code" text REFERENCES "dim_division"("division_code"),
  "load_run_id" uuid REFERENCES "load_run"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_deal_type_idx" ON "fact_deal" ("deal_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_contact_mql_idx" ON "fact_contact" ("became_mql_date");
