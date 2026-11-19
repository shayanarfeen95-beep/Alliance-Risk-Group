-- Chat history: the questions of one conversation, kept together.
--
-- Westport, November 2026: "Also is there chat history? … I asked it to
-- compare 2 months of profitability for SHRC and what drove certain items, very
-- insightful but then it disappeared!" Every question and answer was already
-- logged (ai_query_log), one agent_conversation row per question. thread_id
-- ties the follow-ups of one chat together so the chat can be listed and
-- reopened; a row from before this has none and is its own thread.

ALTER TABLE "agent_conversation" ADD COLUMN IF NOT EXISTS "thread_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_conversation_user_idx" ON "agent_conversation" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_query_log_conversation_idx" ON "ai_query_log" ("conversation_id");
