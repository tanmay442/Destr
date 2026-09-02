CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_uid" uuid;--> statement-breakpoint
UPDATE "documents"
SET "document_uid" = gen_random_uuid()
WHERE "document_uid" IS NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "document_uid" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "document_uid" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_document_uid_unique"
  ON "documents" USING btree ("document_uid");--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "chunk_uid" text;--> statement-breakpoint
UPDATE "chunks"
SET "content_hash" = encode(digest("content", 'sha256'), 'hex');--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "content_hash" SET NOT NULL;--> statement-breakpoint
UPDATE "chunks" AS c
SET "chunk_uid" = encode(
  digest(
    concat_ws(
      '|',
      d."document_uid"::text,
      c."kind",
      c."chunk_index"::text,
      COALESCE((
        SELECT parent."chunk_index"::text
        FROM "chunks" AS parent
        WHERE parent."id" = c."parent_chunk_id"
      ), ''),
      c."content_hash"
    ),
    'sha256'
  ),
  'hex'
)
FROM "documents" AS d
WHERE d."id" = c."document_id";--> statement-breakpoint
WITH duplicate_map AS (
  SELECT
    "id",
    min("id") OVER (PARTITION BY "chunk_uid") AS "keep_id"
  FROM "chunks"
), rewritten AS (
  SELECT
    feedback."turn_id",
    ARRAY(
      SELECT COALESCE(duplicate."keep_id", item."chunk_id")
      FROM LATERAL unnest(feedback."chunk_ids") WITH ORDINALITY AS item("chunk_id", "ordinality")
      LEFT JOIN duplicate_map AS duplicate
        ON duplicate."id" = item."chunk_id"
       AND duplicate."id" <> duplicate."keep_id"
      ORDER BY item."ordinality"
    ) AS "chunk_ids"
  FROM "chat_feedback" AS feedback
)
UPDATE "chat_feedback" AS feedback
SET "chunk_ids" = rewritten."chunk_ids"
FROM rewritten
WHERE rewritten."turn_id" = feedback."turn_id";--> statement-breakpoint
WITH duplicate_map AS (
  SELECT
    "id",
    min("id") OVER (PARTITION BY "chunk_uid") AS "keep_id"
  FROM "chunks"
)
UPDATE "chunks" AS child
SET "parent_chunk_id" = duplicate."keep_id"
FROM duplicate_map AS duplicate
WHERE child."parent_chunk_id" = duplicate."id"
  AND duplicate."id" <> duplicate."keep_id";--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "chunk_uid" ORDER BY "id") AS "row_number"
  FROM "chunks"
)
DELETE FROM "chunks" AS chunk
USING ranked
WHERE chunk."id" = ranked."id"
  AND ranked."row_number" > 1;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "chunk_uid" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chunks_chunk_uid_unique"
  ON "chunks" USING btree ("chunk_uid");