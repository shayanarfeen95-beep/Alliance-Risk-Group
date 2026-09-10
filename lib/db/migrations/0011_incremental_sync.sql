-- How far each source has been read.
--
-- Every pull re-fetched every record a source had ever held. Nothing was
-- duplicated — conform upserts by id — but sixty-four thousand contacts were
-- walked to find the hundred that had changed, and a refresh took long enough
-- that people stopped running it. A sync too slow to run is a sync that does
-- not happen, and a warehouse nobody refreshes is a warehouse nobody can trust.
--
-- The watermark is the newest source-side modification timestamp this system has
-- SUCCESSFULLY conformed for an entity. The next pull asks only for what changed
-- after it.
--
-- It advances only when an entity finishes. A run that stops halfway — budget
-- spent, network lost, deploy mid-pull — leaves the watermark where it was, so
-- the records it did not reach are fetched again next time rather than skipped
-- forever. Re-reading a record costs a second. Missing one silently produces a
-- figure that is wrong in a way nobody goes looking for.

CREATE TABLE IF NOT EXISTS "sync_state" (
  "source_system" text NOT NULL,
  "entity" text NOT NULL,
  "watermark" timestamp with time zone,
  "last_synced_at" timestamp with time zone,
  "last_record_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "sync_state_pk" PRIMARY KEY ("source_system", "entity")
);
