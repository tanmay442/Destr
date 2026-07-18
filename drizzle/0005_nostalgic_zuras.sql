DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'embedding_idx'
      AND indexdef LIKE '%USING hnsw%'
      AND indexdef LIKE '%kind% <> %parent%'
  ) THEN
    DROP INDEX IF EXISTS "embedding_idx";
    CREATE INDEX "embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "chunks"."kind" <> 'parent';
  END IF;
END $$;
