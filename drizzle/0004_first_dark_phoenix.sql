ALTER TABLE "chunks" ADD COLUMN "chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "section_title" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "parent_chunk_id" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "kind" text DEFAULT 'child' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "chunks"."content")) STORED;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_parent_chunk_id_chunks_id_fk" FOREIGN KEY ("parent_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint

-- Backfill sequential chunk_index per document (deterministic order by id)
UPDATE "chunks" AS c SET "chunk_index" = sub.rn FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "document_id" ORDER BY "id") AS rn
  FROM "chunks"
) AS sub WHERE c."id" = sub."id";