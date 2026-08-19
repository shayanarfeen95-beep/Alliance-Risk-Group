-- The salesperson's name, alongside the provider's opaque owner id.
--
-- ARG's leadership asked to filter sales by person. `owner_id` alone cannot
-- serve that: HubSpot's ids look like "owner-3", and a filter listing five
-- opaque ids is a filter nobody uses. The name is denormalised onto the fact
-- rather than kept in a dimension because that is what the connector actually
-- lands — HubSpot returns the owner on the deal, and a join table would be a
-- second thing to keep in sync for no gain at this volume.
--
-- Nullable on purpose: a deal with no assigned owner is a real state, and it
-- must read as "unassigned" rather than being hidden from every filtered view.

ALTER TABLE "fact_deal" ADD COLUMN IF NOT EXISTS "owner_name" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fact_deal_owner_idx" ON "fact_deal" ("owner_name");
