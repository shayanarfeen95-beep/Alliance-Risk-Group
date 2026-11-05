-- The HubSpot fields ARG's leadership review is defined on.
--
-- Westport's corrections to the Leadership dashboard (October 2026) define every
-- chart on HubSpot properties this warehouse never fetched:
--
-- fact_deal.line_of_business
--   "Everything on this Leadership dashboard should only be for our background
--   screening side of the business": Line of Business is any of Background
--   Checks. Stored as the option LABEL people see in HubSpot, not its internal
--   value, so a filter reads the way the property reads.
--
-- fact_deal.compliance_review_completed_at
--   "Date Compliance Review Completed" — a deal property, and the date most of
--   the review's monthly charts are counted on.
--
-- fact_deal.created_by_user_id / created_by_name
--   Deals created by month excludes deals created by one named user. HubSpot's
--   "Created by" is a user id (hs_created_by_user_id), which is not an owner id;
--   the name is resolved from the owners list, where each owner carries both.
--
-- fact_contact.lead_source / mql_entered_at
--   SQLs per month: "Date entered Marketing Qualified Lead (Lifecycle Stage
--   Pipeline)" is known, and Lead Source is one of four values.
--
-- dim_hubspot_property
--   HubSpot's own field definitions. Custom properties have internal names
--   nobody types (line_of_business, line_of_business__c, …), so fields are found
--   by their LABEL — the words in Westport's definitions — and option values are
--   translated back to the labels people see. Kept as reference data so Admin
--   can show which field each chart actually reads.
--
-- sync_state.fields_version
--   Which set of fields the last completed pass asked for. When it changes, the
--   next pull reads that object from the beginning rather than only what was
--   modified since — otherwise a deal nobody has touched since last week would
--   never get its Line of Business.

ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "line_of_business" text;
--> statement-breakpoint
ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "compliance_review_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "created_by_name" text;
--> statement-breakpoint
ALTER TABLE "fact_contact" ADD COLUMN IF NOT EXISTS "lead_source" text;
--> statement-breakpoint
ALTER TABLE "fact_contact" ADD COLUMN IF NOT EXISTS "mql_entered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "fields_version" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dim_hubspot_property" (
  "object_type" text NOT NULL,
  "name" text NOT NULL,
  "label" text NOT NULL,
  "type" text,
  "field_type" text,
  "group_name" text,
  "options" jsonb,
  "load_run_id" uuid REFERENCES "load_run"("id"),
  CONSTRAINT "dim_hubspot_property_pk" PRIMARY KEY ("object_type", "name")
);
