-- Stored source credentials.
--
-- One row per source system. The secret payload is AES-256-GCM ciphertext, not
-- a token: a database dump must not hand someone ARG's accounting system. What
-- stays in the clear is only what the admin screen needs to describe the
-- connection — which company is linked, when the token expires, who connected
-- it — because a connection nobody can inspect is a connection nobody trusts.

CREATE TABLE IF NOT EXISTS "connector_credential" (
  "source_system" text PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'CONNECTED',
  "auth_method" text NOT NULL,
  "secret" text NOT NULL,
  "account_label" text,
  "account_id" text,
  "scopes" text,
  "expires_at" timestamp with time zone,
  "last_refreshed_at" timestamp with time zone,
  "last_error" text,
  "connected_by_user_id" uuid REFERENCES "users"("id"),
  "connected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Short-lived, single-use state for the OAuth round trip. Rows are deleted on
-- use; the expiry is the backstop for a flow the user abandoned.
CREATE TABLE IF NOT EXISTS "oauth_state" (
  "state" text PRIMARY KEY,
  "source_system" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "redirect_to" text,
  "code_verifier" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_state_expiry_idx" ON "oauth_state" ("expires_at");
