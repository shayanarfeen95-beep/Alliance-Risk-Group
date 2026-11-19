-- HubSpot's "Estimated Close Date" on a deal.
--
-- Westport, November 2026: "Estimated Close Date should be listed to understand
-- when deals will close, it is a HUBSPOT field but it does not appear to be
-- mapping over." Found by its label, like the other leadership fields; where a
-- portal has no such custom field, HubSpot's own Close Date on an open deal is
-- the expected date and is shown instead.

ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "estimated_close_date" timestamp with time zone;
