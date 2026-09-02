-- The partitioned chat_events table cannot have a database-wide UNIQUE
-- constraint on turn_id without including created_at. The non-partitioned
-- chat_turns registry is therefore the global uniqueness authority.
--
-- Migration 0029 serialized inserts on the registry row and then searched all
-- chat_events partitions for an existing turn. Without a created_at predicate,
-- that lookup cannot use partition pruning and grows with both row and partition
-- counts. Claiming the registry primary key directly provides the same atomic
-- invariant without consulting the partitioned event table.
CREATE OR REPLACE FUNCTION destr_register_chat_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claimed_turn_id uuid;
BEGIN
  IF NEW.turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO chat_turns (turn_id, created_at, user_id)
  VALUES (NEW.turn_id, NEW.created_at, NEW.user_id)
  ON CONFLICT (turn_id) DO NOTHING
  RETURNING turn_id INTO claimed_turn_id;

  IF claimed_turn_id IS NULL THEN
    RAISE EXCEPTION 'chat turn % already has an event', NEW.turn_id
      USING ERRCODE = '23505', CONSTRAINT = 'chat_events_turn_id_global_unique';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A registry row is owned by exactly one non-null chat event. The BEFORE INSERT
-- claim above prevents a second event from sharing it, so deletion can remove
-- the registry row directly. This also removes the old cleanup trigger's
-- cross-partition NOT EXISTS scan. Foreign-key cascades clean up feedback and
-- reviews, while the event-to-registry RESTRICT constraint is already satisfied
-- in this AFTER DELETE trigger.
CREATE OR REPLACE FUNCTION destr_cleanup_chat_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.turn_id IS NOT NULL THEN
    DELETE FROM chat_turns WHERE turn_id = OLD.turn_id;
  END IF;
  RETURN OLD;
END;
$$;
