-- The seeded reporting month, unpinned.
--
-- DEFAULT_REPORTING_MONTH was written as 2026-03-01 by the original seed, when
-- March 2026 was the month the specification's reference figures tie to. It was
-- never a choice anybody made about ARG's live books, and it kept surfacing: the
-- assistant answered questions about March from pages showing August. Dashboards
-- open on the last completed month with data; the pin is kept only as an
-- explicit, optional override, and a seeded value is not one.
UPDATE "app_config"
SET "value" = '',
    "description" = 'Optional. Pin every dashboard to a month (YYYY-MM-01). Leave empty to open on the last completed month that has data — the normal setting.',
    "updated_at" = now()
WHERE "key" = 'DEFAULT_REPORTING_MONTH' AND "value" = '2026-03-01';
