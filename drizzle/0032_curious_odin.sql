ALTER TABLE "chunks" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section_title, '')), 'B') ||
    setweight(to_tsvector('english', content), 'D')
  ) STORED;--> statement-breakpoint
CREATE INDEX "chunks_search_tsv_idx" ON "chunks" USING gin ("search_tsv");