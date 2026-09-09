-- Demonstration mode is gone; every deployment reads its own books.
--
-- 0006 introduced DATA_MODE and defaulted it to DEMONSTRATION, which made sense
-- while a deployment seeded itself on first boot. Nothing seeds itself now, so a
-- warehouse holding DEMONSTRATION would hide exactly the rows a source loaded
-- and show nothing in their place.
--
-- Databases that actually contain seeded rows keep their setting: there the
-- label is true, and switching it silently would present fabricated figures as
-- ARG's own.
UPDATE "app_config"
SET "value" = 'LIVE'
WHERE "key" = 'DATA_MODE'
  AND "value" = 'DEMONSTRATION'
  AND NOT EXISTS (SELECT 1 FROM "load_run" WHERE "source_system" = 'SEED');
