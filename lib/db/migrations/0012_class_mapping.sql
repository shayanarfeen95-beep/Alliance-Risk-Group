-- What each QuickBooks class means.
--
-- Class is how ARG separates divisions in QuickBooks, and the mapping lived only
-- in seeded arrays on dim_division — so a class the seed had never heard of
-- could not be mapped at all. Conform refuses a month containing an unmapped
-- class, which is right: loading it against the wrong division, or silently
-- dropping it, moves revenue between two divisional P&Ls with nothing on any
-- screen saying so. But with nowhere to record the decision, "refuses" meant
-- "nothing ever loads" — the first real QuickBooks pull wrote zero rows against
-- PS-APS, PS-Other, PS-TP, Z Alloc and Not Specified.
--
-- Three states, and the third is the one that was missing:
--
--   UNMAPPED  Nobody has said what this is. A month containing it is refused.
--             The safe default, and deliberately obstructive.
--   MAPPED    It belongs to a division; its figures load against that division.
--   EXCLUDED  It is deliberately not a division — an allocation bucket, an
--             unclassified catch-all, a class kept for something other than
--             divisional reporting. Its figures are left out, the month loads,
--             and the affected views say so rather than quietly under-reporting.
--
-- Decisions carry who made them and when. Mapping a class changes what every
-- divisional P&L says, which is precisely what an auditor asks about.

CREATE TABLE IF NOT EXISTS "dim_class_map" (
  "class_key" text PRIMARY KEY NOT NULL,
  "class_id" text,
  "class_name" text NOT NULL,
  "division_code" text REFERENCES "dim_division"("division_code"),
  "decision" text DEFAULT 'UNMAPPED' NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
