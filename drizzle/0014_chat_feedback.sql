ALTER TABLE chat_events ADD COLUMN IF NOT EXISTS turn_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_events_turn_id_unique ON chat_events (turn_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_feedback (
  turn_id uuid PRIMARY KEY
    CONSTRAINT chat_feedback_turn_id_chat_events_turn_id_fk
      REFERENCES chat_events(turn_id),
  feedback smallint NOT NULL,
  document_ids integer[] NOT NULL DEFAULT '{}',
  chunk_ids integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_feedback_value_check CHECK (feedback IN (1, -1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_events_meta_document_ids ON chat_events USING gin ((meta -> 'documentIds'));
