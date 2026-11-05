-- Import only what is new or changed.
--
-- Every Pull re-imported every month in its window, and so did the nightly
-- refresh: a year of closed, unchanged books rewritten each time, and a log that
-- could not say what had actually changed. This table holds a fingerprint of
-- what each QuickBooks month, Sheets tab and reference list looked like when it
-- was last imported. A pull fetches what could have changed, compares, and
-- imports only the months and tabs whose content is different — unless somebody
-- asks for "Re-import everything".

CREATE TABLE IF NOT EXISTS "sync_fingerprint" (
  "source_system" text NOT NULL,
  "entity" text NOT NULL,
  "scope" text NOT NULL,
  "content_hash" text NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "load_run_id" uuid REFERENCES "load_run"("id"),
  CONSTRAINT "sync_fingerprint_pk" PRIMARY KEY ("source_system", "entity", "scope")
);
