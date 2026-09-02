-- One-click source sign-in through Composio.
--
-- The connection is begun before the user leaves for the provider, so the
-- connected-account id exists at that moment and must survive the round trip.
-- It is held on the pending state row rather than trusted from the callback's
-- query string: a callback that can name its own connected account is a callback
-- that can bind ARG's dashboard to someone else's books.
ALTER TABLE "oauth_state"
  ADD COLUMN IF NOT EXISTS "composio_connected_account_id" text;
