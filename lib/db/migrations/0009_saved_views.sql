-- Views somebody built and kept.
--
-- The dashboards answer the questions the build anticipated. This is how a
-- question nobody anticipated gets a permanent home — "closed-won by lead
-- source for Claims, last six months" is a reasonable thing to want on screen
-- every month, and it should not require a developer.
--
-- What is stored is a SPEC, never a result set and never a number. Figures are
-- resolved through the semantic layer each time the view is opened, so a saved
-- view cannot drift from the dashboards, cannot preserve a figure that has since
-- been restated, and cannot outlive a metric definition changing — it either
-- re-resolves or it fails loudly and says so. It is also what makes a view safe
-- to share: it carries no data, so each reader sees exactly what their own
-- entitlements allow, and sharing a view can never leak a division.

CREATE TABLE IF NOT EXISTS "saved_view" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "spec" jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_by_agent" boolean DEFAULT false NOT NULL,
  "is_shared" boolean DEFAULT true NOT NULL,
  "pinned_to" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_view_pinned_idx" ON "saved_view" ("pinned_to");
