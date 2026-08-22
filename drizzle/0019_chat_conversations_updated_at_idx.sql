-- Retention purge (purgeOlderThan) scans chat_conversations by updated_at
-- across all users; the existing (user_id, updated_at) index cannot serve it.
CREATE INDEX IF NOT EXISTS chat_conversations_updated_at_idx ON chat_conversations (updated_at);
