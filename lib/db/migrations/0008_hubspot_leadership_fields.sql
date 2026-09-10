-- The three fields the leadership review is actually read along.
--
-- ARG's HubSpot leadership dashboard answers its questions on axes this
-- warehouse could not express: how many discovery calls and demos happened and
-- who ran them, and where new pipeline came from. All three were already in
-- HubSpot and none of them were being landed.
--
--   activity_type  Meetings carry `hs_activity_type` — HubSpot's "Call and
--                  meeting type". Discovery Calls, Demos and Compliance Reviews
--                  are not separate objects, they are values of this one field,
--                  so without it every meeting is an undifferentiated tally.
--                  Nullable: HubSpot does not require it, and a meeting logged
--                  without a type is a real meeting that must keep counting in
--                  the total rather than disappearing from it.
--
--   owner_name     Meetings landed with `owner_id` only, so "meetings by rep"
--                  could only have been a list of opaque ids. Resolved at load
--                  from the owners entity, exactly as fact_deal.owner_name is.
--
--   source_label   Where a deal came from, as the business records it. This is
--                  not a contact's original traffic source: "Employee Referral"
--                  and "Trade Show/Conference" are not things HubSpot analytics
--                  can observe, they are things a salesperson states. Pipeline
--                  attribution is read off this, so it belongs on the deal
--                  rather than being inferred from an associated contact.
--
-- All three are nullable and unbackfilled. Existing rows read as null until the
-- next pull, which is honest: the previous load genuinely did not fetch them,
-- and a default would assert a type and a source that nobody recorded.

ALTER TABLE "fact_meeting" ADD COLUMN IF NOT EXISTS "activity_type" text;
--> statement-breakpoint
ALTER TABLE "fact_meeting" ADD COLUMN IF NOT EXISTS "owner_name" text;
--> statement-breakpoint
ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "source_label" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_meeting_type_idx" ON "fact_meeting" ("activity_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_deal_source_idx" ON "fact_deal" ("source_label");
