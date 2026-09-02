-- Demonstration data, or ARG's own books.
--
-- Carried as configuration rather than as an environment variable, because it is
-- an operational decision made once by a person with a reason, and it belongs in
-- the audit trail beside the other decisions. Defaults to DEMONSTRATION: a fresh
-- deployment shows the seeded dataset and says so, and going live is a
-- deliberate act rather than the absence of one.
INSERT INTO "app_config" ("key", "value", "description", "is_confirmed")
VALUES (
  'DATA_MODE',
  'DEMONSTRATION',
  'Which figures the dashboards read. DEMONSTRATION shows the seeded dataset so every view can be exercised before a source is connected, and says so on every page. LIVE excludes every seeded row, so only data loaded from QuickBooks, HubSpot or Google Sheets is shown and an unloaded month reads as unavailable rather than as a figure.',
  true
)
ON CONFLICT ("key") DO NOTHING;
