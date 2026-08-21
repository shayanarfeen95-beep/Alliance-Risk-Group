-- Actions the agent has proposed and a human has not yet confirmed.
--
-- Ingestion already had this shape: `load_run` holds a PREVIEW row and nothing
-- is written until somebody clicks confirm. The agent can now propose a second
-- kind of write — the HubSpot division mapping — and that one deserves the same
-- gate for a stronger reason. Changing the attribution rule silently restates
-- every divisional sales figure in every prior month; it is not something a
-- conversation should be able to do on its own say-so.
--
-- The proposal is stored rather than passed through the browser so that what is
-- applied is exactly what was shown. A payload the client could edit between
-- preview and confirm would make the preview a decoration.

CREATE TABLE IF NOT EXISTS "agent_pending_action" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" uuid,
  -- 'HUBSPOT_MAPPING' today. One column rather than an enum: a new kind of
  -- proposal should not need a migration to be reviewable.
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "detail" text NOT NULL,
  "payload" jsonb NOT NULL,
  -- PENDING | APPLIED | CANCELLED
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_pending_action_user_idx" ON "agent_pending_action" ("user_id", "status");
--> statement-breakpoint
-- Pinned boxes are per person, and every dashboard reads them by page.
CREATE INDEX IF NOT EXISTS "generated_view_pinned_idx" ON "generated_view" ("user_id", "pinned_to");
