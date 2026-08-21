-- Super admin, and access that can be lent rather than given away.
--
-- "Super admin and delegation/access" from the 13 Aug next-steps list. Two
-- things were missing and they are different problems:
--
--   1. **Who owns the deployment.** Westport holds the database, the source
--      credentials and the mappings; ARG holds its own people. Both were
--      "ADMIN", which meant either Westport could not hand ARG real
--      administration, or ARG could disconnect QuickBooks. A super admin flag
--      separates the two without inventing a second application.
--
--   2. **Temporary access.** "Let Scott close the books while I'm away" is a
--      grant with an end date, not a role change somebody has to remember to
--      undo. A role change survives the reason for it; this does not.
--
-- Every grant records who gave it, why, and when it lapses, because the first
-- question after an unexpected write is always "who could do that, and since
-- when?".

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_super_admin" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_grant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- A capability name from lib/auth/scope.ts. Text rather than an enum so a new
  -- capability does not need a migration to become delegable.
  "capability" text NOT NULL,
  -- Optional narrowing: a grant can be for one division rather than all.
  "division_code" text REFERENCES "dim_division"("division_code"),
  "granted_by" uuid NOT NULL REFERENCES "users"("id"),
  -- Required. A grant with no stated reason is one nobody can review later.
  "reason" text NOT NULL,
  -- NULL means "until revoked" — allowed, but the screen says so plainly.
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_grant_user_idx" ON "access_grant" ("user_id", "revoked_at");
