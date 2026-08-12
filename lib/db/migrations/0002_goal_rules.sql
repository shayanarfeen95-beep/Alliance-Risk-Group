-- Standing goals carry a typed rule alongside their human-readable instruction.
--
-- The instruction is what the owner wrote and what the commentary quotes back.
-- The rule is what actually runs, and it runs in TypeScript against resolveKpi
-- rather than being interpreted by a model — a goal that fires an exception onto
-- the CEO's dashboard has to be reproducible, and a model re-reading free text
-- each night is not. `evaluator` names the built-in rule; `params` holds its
-- validated parameters.

ALTER TABLE "agent_goal" ADD COLUMN IF NOT EXISTS "evaluator" text;
--> statement-breakpoint
ALTER TABLE "agent_goal" ADD COLUMN IF NOT EXISTS "params" jsonb;
--> statement-breakpoint
-- A goal with no evaluator would sit there looking active while never firing.
-- Backfill the column, then require it.
UPDATE "agent_goal" SET "evaluator" = 'KPI_THRESHOLD' WHERE "evaluator" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_goal" ALTER COLUMN "evaluator" SET NOT NULL;
--> statement-breakpoint
-- Findings are deduplicated per goal, month and division: an unchanged exception
-- should not stack up a new row on every overnight refresh. Thirty rows for one
-- unresolved breach reads as thirty problems.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_finding_unique_per_period"
  ON "agent_finding" ("goal_id", "period_month", COALESCE("division_code", ''), "headline");
