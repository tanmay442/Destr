-- `bigserial` is a schema shorthand, not an ALTER TABLE data type. Widen the
-- columns and their owned sequences explicitly so existing values/defaults
-- remain intact while future inserts can exceed the signed 32-bit range.
ALTER TABLE "audit_events" ALTER COLUMN "id" SET DATA TYPE bigint USING "id"::bigint;--> statement-breakpoint
ALTER TABLE "chat_events" ALTER COLUMN "id" SET DATA TYPE bigint USING "id"::bigint;--> statement-breakpoint
ALTER TABLE "quality_reviews" ALTER COLUMN "id" SET DATA TYPE bigint USING "id"::bigint;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "id" SET DATA TYPE bigint USING "id"::bigint;--> statement-breakpoint
ALTER SEQUENCE "audit_events_id_seq" AS bigint;--> statement-breakpoint
ALTER SEQUENCE "chat_events_id_seq" AS bigint;--> statement-breakpoint
ALTER SEQUENCE "quality_reviews_id_seq" AS bigint;--> statement-breakpoint
ALTER SEQUENCE "tickets_id_seq" AS bigint;--> statement-breakpoint
DO $$
DECLARE
  max_id bigint;
  sequence_last bigint;
  sequence_called boolean;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM "audit_events";
  SELECT last_value, is_called INTO sequence_last, sequence_called FROM "audit_events_id_seq";
  IF max_id > sequence_last OR (max_id = sequence_last AND NOT sequence_called) THEN
    PERFORM setval('audit_events_id_seq'::regclass, max_id, true);
  END IF;

  SELECT COALESCE(MAX(id), 0) INTO max_id FROM "chat_events";
  SELECT last_value, is_called INTO sequence_last, sequence_called FROM "chat_events_id_seq";
  IF max_id > sequence_last OR (max_id = sequence_last AND NOT sequence_called) THEN
    PERFORM setval('chat_events_id_seq'::regclass, max_id, true);
  END IF;

  SELECT COALESCE(MAX(id), 0) INTO max_id FROM "quality_reviews";
  SELECT last_value, is_called INTO sequence_last, sequence_called FROM "quality_reviews_id_seq";
  IF max_id > sequence_last OR (max_id = sequence_last AND NOT sequence_called) THEN
    PERFORM setval('quality_reviews_id_seq'::regclass, max_id, true);
  END IF;

  SELECT COALESCE(MAX(id), 0) INTO max_id FROM "tickets";
  SELECT last_value, is_called INTO sequence_last, sequence_called FROM "tickets_id_seq";
  IF max_id > sequence_last OR (max_id = sequence_last AND NOT sequence_called) THEN
    PERFORM setval('tickets_id_seq'::regclass, max_id, true);
  END IF;
END $$;
