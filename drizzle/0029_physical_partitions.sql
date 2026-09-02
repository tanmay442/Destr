-- Physical layout for the high-growth append-only tables. This migration is
-- intentionally forward-only: it copies the old tables into new parents and
-- verifies row counts before the transaction commits. The migration runner
-- wraps this file in one transaction and takes the project advisory lock.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint

-- Preflight: the old chat_events uniqueness invariant must be clean before it
-- is represented by the non-partitioned turn registry and an insert trigger.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat_events
    WHERE turn_id IS NOT NULL
    GROUP BY turn_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0029 preflight: duplicate non-null chat_events.turn_id values exist';
  END IF;
END $$;
--> statement-breakpoint

-- The materialized view depends on the old relation OID. Recreate it after
-- cutover so analytics read the partitioned parent rather than a copy table.
DROP MATERIALIZED VIEW IF EXISTS chat_daily_stats;
--> statement-breakpoint

-- Keep the sequence objects while replacing their owning tables.
ALTER SEQUENCE chat_events_id_seq OWNED BY NONE;
--> statement-breakpoint
ALTER SEQUENCE audit_events_id_seq OWNED BY NONE;
--> statement-breakpoint
ALTER SEQUENCE chat_messages_id_seq OWNED BY NONE;
--> statement-breakpoint

-- Preserve source rows in transaction-local copies. The old tables can then be
-- removed without leaving duplicate index/constraint names behind.
CREATE TEMP TABLE _destr_chat_events_source ON COMMIT DROP AS
SELECT * FROM chat_events;
--> statement-breakpoint
CREATE TEMP TABLE _destr_audit_events_source ON COMMIT DROP AS
SELECT * FROM audit_events;
--> statement-breakpoint
CREATE TEMP TABLE _destr_chat_messages_source ON COMMIT DROP AS
SELECT * FROM chat_messages;
--> statement-breakpoint

-- The old child FKs point at the old chat_events unique index. They are
-- replaced with registry FKs below.
ALTER TABLE chat_feedback
  DROP CONSTRAINT IF EXISTS chat_feedback_turn_id_chat_events_turn_id_fk;
--> statement-breakpoint
ALTER TABLE quality_reviews
  DROP CONSTRAINT IF EXISTS quality_reviews_turn_id_chat_events_turn_id_fk;
--> statement-breakpoint

CREATE TABLE chat_turns (
  turn_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  user_id text
);
--> statement-breakpoint
CREATE INDEX chat_turns_created_at_idx ON chat_turns (created_at);
--> statement-breakpoint
CREATE INDEX chat_turns_user_id_idx ON chat_turns (user_id);
--> statement-breakpoint

INSERT INTO chat_turns (turn_id, created_at, user_id)
SELECT turn_id, created_at, user_id
FROM _destr_chat_events_source
WHERE turn_id IS NOT NULL;
--> statement-breakpoint

DROP TABLE chat_events;
--> statement-breakpoint
DROP TABLE audit_events;
--> statement-breakpoint
DROP TABLE chat_messages;
--> statement-breakpoint

CREATE TABLE chat_events (
  id bigint NOT NULL DEFAULT nextval('chat_events_id_seq'::regclass),
  turn_id uuid,
  user_id text,
  query text,
  mode text NOT NULL,
  retrieve_ms integer,
  generate_ms integer,
  total_ms integer,
  hit_count integer,
  max_similarity real,
  out_of_domain boolean NOT NULL DEFAULT false,
  hallucination_blocked boolean NOT NULL DEFAULT false,
  cache_hit boolean NOT NULL DEFAULT false,
  ticket_created boolean NOT NULL DEFAULT false,
  citation_count integer,
  tokens_in integer,
  tokens_out integer,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_events_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT chat_events_mode_check CHECK (mode IN ('agentic','vector'))
) PARTITION BY RANGE (created_at);
--> statement-breakpoint

CREATE TABLE audit_events (
  id bigint NOT NULL DEFAULT nextval('audit_events_id_seq'::regclass),
  kind text NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  source_ref text,
  CONSTRAINT audit_events_pkey PRIMARY KEY (id, at),
  CONSTRAINT audit_events_kind_check CHECK (kind IN ('document','ticket','user','settings','chat'))
) PARTITION BY RANGE (at);
--> statement-breakpoint

CREATE TABLE chat_messages (
  id bigint NOT NULL DEFAULT nextval('chat_messages_id_seq'::regclass),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id uuid,
  role text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (conversation_id, id),
  CONSTRAINT chat_messages_role_check CHECK (role IN ('user','assistant')),
  CONSTRAINT chat_messages_content_bytes_check CHECK (octet_length(content::text) <= 256000)
) PARTITION BY HASH (conversation_id);
--> statement-breakpoint

-- Range partitions cover every historical month through six complete future
-- months. A monitored default is an emergency buffer only; postflight must
-- find it empty after the copy.
DO $$
DECLARE
  first_month timestamptz;
  last_month timestamptz;
  month_start timestamptz;
  next_month timestamptz;
  partition_name text;
BEGIN
  SELECT date_trunc('month', min(created_at)) INTO first_month FROM _destr_chat_events_source;
  IF first_month IS NULL THEN first_month := date_trunc('month', now()) - interval '1 month'; END IF;
  SELECT date_trunc('month', greatest(coalesce(max(created_at), now()), now())) + interval '7 months'
    INTO last_month FROM _destr_chat_events_source;
  month_start := first_month;
  WHILE month_start < last_month LOOP
    next_month := month_start + interval '1 month';
    partition_name := 'chat_events_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF chat_events FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, next_month
    );
    month_start := next_month;
  END LOOP;
  CREATE TABLE chat_events_default PARTITION OF chat_events DEFAULT;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  first_month timestamptz;
  last_month timestamptz;
  month_start timestamptz;
  next_month timestamptz;
  partition_name text;
BEGIN
  SELECT date_trunc('month', min(at)) INTO first_month FROM _destr_audit_events_source;
  IF first_month IS NULL THEN first_month := date_trunc('month', now()) - interval '1 month'; END IF;
  SELECT date_trunc('month', greatest(coalesce(max(at), now()), now())) + interval '7 months'
    INTO last_month FROM _destr_audit_events_source;
  month_start := first_month;
  WHILE month_start < last_month LOOP
    next_month := month_start + interval '1 month';
    partition_name := 'audit_events_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, next_month
    );
    month_start := next_month;
  END LOOP;
  CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  remainder integer;
BEGIN
  FOR remainder IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF chat_messages FOR VALUES WITH (MODULUS 32, REMAINDER %s)',
      'chat_messages_p' || lpad(remainder::text, 2, '0'), remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

INSERT INTO chat_events (
  id, turn_id, user_id, query, mode, retrieve_ms, generate_ms, total_ms,
  hit_count, max_similarity, out_of_domain, hallucination_blocked, cache_hit,
  ticket_created, citation_count, tokens_in, tokens_out, meta, created_at
)
SELECT
  id, turn_id, user_id, query, mode, retrieve_ms, generate_ms, total_ms,
  hit_count, max_similarity, out_of_domain, hallucination_blocked, cache_hit,
  ticket_created, citation_count, tokens_in, tokens_out, meta, created_at
FROM _destr_chat_events_source
ORDER BY id;
--> statement-breakpoint

INSERT INTO audit_events (
  id, kind, action, actor_id, target_type, target_id, details, at, source_ref
)
SELECT id, kind, action, actor_id, target_type, target_id, details, at, source_ref
FROM _destr_audit_events_source
ORDER BY id;
--> statement-breakpoint

INSERT INTO chat_messages (id, conversation_id, turn_id, role, content, created_at)
SELECT id, conversation_id, turn_id, role, content, created_at
FROM _destr_chat_messages_source
ORDER BY id;
--> statement-breakpoint

CREATE INDEX chat_events_created_at_idx ON chat_events (created_at DESC);
--> statement-breakpoint
CREATE INDEX chat_events_mode_idx ON chat_events (mode);
--> statement-breakpoint
CREATE INDEX chat_events_user_id_idx ON chat_events (user_id);
--> statement-breakpoint
CREATE INDEX idx_chat_events_meta_document_ids ON chat_events USING gin ((meta -> 'documentIds'));
--> statement-breakpoint

CREATE INDEX audit_events_kind_idx ON audit_events (kind);
--> statement-breakpoint
CREATE INDEX audit_events_at_id_idx ON audit_events (at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX audit_events_actor_id_idx ON audit_events (actor_id);
--> statement-breakpoint
CREATE INDEX audit_events_kind_target_id_idx ON audit_events (kind, target_id);
--> statement-breakpoint

CREATE INDEX idx_chat_messages_conversation_id ON chat_messages (conversation_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_messages_turn_unique ON chat_messages (conversation_id, turn_id, role);
--> statement-breakpoint

ALTER SEQUENCE chat_events_id_seq OWNED BY chat_events.id;
--> statement-breakpoint
ALTER SEQUENCE audit_events_id_seq OWNED BY audit_events.id;
--> statement-breakpoint
ALTER SEQUENCE chat_messages_id_seq OWNED BY chat_messages.id;
--> statement-breakpoint

SELECT setval(
  'chat_events_id_seq'::regclass,
  coalesce((SELECT max(id) FROM chat_events), 1),
  (SELECT count(*) > 0 FROM chat_events)
);
--> statement-breakpoint
SELECT setval(
  'audit_events_id_seq'::regclass,
  coalesce((SELECT max(id) FROM audit_events), 1),
  (SELECT count(*) > 0 FROM audit_events)
);
--> statement-breakpoint
SELECT setval(
  'chat_messages_id_seq'::regclass,
  coalesce((SELECT max(id) FROM chat_messages), 1),
  (SELECT count(*) > 0 FROM chat_messages)
);
--> statement-breakpoint

ALTER TABLE chat_events
  ADD CONSTRAINT chat_events_turn_id_chat_turns_turn_id_fk
  FOREIGN KEY (turn_id) REFERENCES chat_turns(turn_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE chat_feedback
  ADD CONSTRAINT chat_feedback_turn_id_chat_turns_turn_id_fk
  FOREIGN KEY (turn_id) REFERENCES chat_turns(turn_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE quality_reviews
  ADD CONSTRAINT quality_reviews_turn_id_chat_turns_turn_id_fk
  FOREIGN KEY (turn_id) REFERENCES chat_turns(turn_id) ON DELETE CASCADE;
--> statement-breakpoint

-- BEFORE INSERT registers a turn and serializes duplicate checks on the small
-- registry row. This keeps direct SQL callers and the buffered event writer on
-- the same atomic contract without exposing partition routing to the domain.
CREATE OR REPLACE FUNCTION destr_register_chat_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO chat_turns (turn_id, created_at, user_id)
  VALUES (NEW.turn_id, NEW.created_at, NEW.user_id)
  ON CONFLICT (turn_id) DO NOTHING;

  PERFORM 1 FROM chat_turns WHERE turn_id = NEW.turn_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM chat_events WHERE turn_id = NEW.turn_id) THEN
    RAISE EXCEPTION 'chat turn % already has an event', NEW.turn_id
      USING ERRCODE = '23505', CONSTRAINT = 'chat_events_turn_id_global_unique';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_events_register_turn
  BEFORE INSERT ON chat_events
  FOR EACH ROW EXECUTE FUNCTION destr_register_chat_turn();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION destr_cleanup_chat_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.turn_id IS NOT NULL THEN
    DELETE FROM chat_turns
    WHERE turn_id = OLD.turn_id
      AND NOT EXISTS (SELECT 1 FROM chat_events WHERE turn_id = OLD.turn_id);
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_events_cleanup_turn
  AFTER DELETE ON chat_events
  FOR EACH ROW EXECUTE FUNCTION destr_cleanup_chat_turn();
--> statement-breakpoint

-- The registry also makes the turn identity immutable. Without this guard an
-- UPDATE could move an event to another registry key and bypass the INSERT
-- trigger's global duplicate check (and could also invalidate partition
-- pruning through the registry's created_at binding).
CREATE OR REPLACE FUNCTION destr_protect_chat_turn_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat event turn_id and created_at are immutable'
      USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_events_protect_turn_key
  BEFORE UPDATE OF turn_id, created_at ON chat_events
  FOR EACH ROW EXECUTE FUNCTION destr_protect_chat_turn_key();
--> statement-breakpoint

-- Recreate the existing analytics view against the new parent. The view is
-- deliberately unchanged so dashboard semantics remain identical.
CREATE MATERIALIZED VIEW chat_daily_stats AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
  mode,
  count(*) AS total,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_ms,
  avg(retrieve_ms) AS avg_retrieve_ms,
  avg(generate_ms) AS avg_generate_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p95_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY generate_ms) AS generate_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY generate_ms) AS generate_p95_ms,
  avg(max_similarity) AS avg_max_similarity,
  count(*) FILTER (WHERE cache_hit) AS cache_hits,
  count(*) FILTER (WHERE out_of_domain) AS ood_count,
  count(*) FILTER (WHERE hallucination_blocked) AS hallucination_count,
  count(*) FILTER (WHERE ticket_created) AS tickets_created,
  count(*) FILTER (WHERE NOT ticket_created AND NOT out_of_domain) AS self_serve_count,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  count(DISTINCT user_id) AS unique_users
FROM chat_events
GROUP BY 1, 2
WITH DATA;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_chat_daily_stats ON chat_daily_stats (day, mode);
--> statement-breakpoint

-- Postflight: every source row survived, every non-null turn has one registry
-- row, and no source row landed in an emergency default partition.
DO $$
DECLARE
  source_count bigint;
  target_count bigint;
  registry_count bigint;
  default_events bigint;
  default_audit bigint;
BEGIN
  SELECT count(*) INTO source_count FROM _destr_chat_events_source;
  SELECT count(*) INTO target_count FROM chat_events;
  IF source_count <> target_count THEN
    RAISE EXCEPTION '0029 postflight: chat_events row count changed (% vs %)', target_count, source_count;
  END IF;

  SELECT count(*) INTO source_count FROM _destr_audit_events_source;
  SELECT count(*) INTO target_count FROM audit_events;
  IF source_count <> target_count THEN
    RAISE EXCEPTION '0029 postflight: audit_events row count changed (% vs %)', target_count, source_count;
  END IF;

  SELECT count(*) INTO source_count FROM _destr_chat_messages_source;
  SELECT count(*) INTO target_count FROM chat_messages;
  IF source_count <> target_count THEN
    RAISE EXCEPTION '0029 postflight: chat_messages row count changed (% vs %)', target_count, source_count;
  END IF;

  SELECT count(*) INTO registry_count FROM chat_turns;
  SELECT count(*) INTO source_count FROM _destr_chat_events_source WHERE turn_id IS NOT NULL;
  IF registry_count <> source_count THEN
    RAISE EXCEPTION '0029 postflight: chat_turns registry count changed (% vs %)', registry_count, source_count;
  END IF;

  SELECT count(*) INTO default_events FROM chat_events_default;
  SELECT count(*) INTO default_audit FROM audit_events_default;
  IF default_events <> 0 OR default_audit <> 0 THEN
    RAISE EXCEPTION '0029 postflight: rows landed in default partitions (chat_events %, audit_events %)', default_events, default_audit;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    WHERE c.relname = 'chat_messages'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    WHERE c.relname = 'chat_events'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    WHERE c.relname = 'audit_events'
  ) THEN
    RAISE EXCEPTION '0029 postflight: expected partitioned parents are missing';
  END IF;
END $$;
