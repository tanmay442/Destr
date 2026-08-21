CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(clerk_user_id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_conversations_title_len_check CHECK (char_length(title) <= 120)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_updated ON chat_conversations (user_id, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id uuid,
  role text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_role_check CHECK (role IN ('user','assistant')),
  CONSTRAINT chat_messages_content_bytes_check CHECK (octet_length(content::text) <= 256000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages (conversation_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_turn_unique ON chat_messages (conversation_id, turn_id, role);
--> statement-breakpoint
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_check;
--> statement-breakpoint
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_check CHECK (kind IN ('document','ticket','user','settings','chat'));
