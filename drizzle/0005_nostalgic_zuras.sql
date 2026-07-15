DROP INDEX "embedding_idx";--> statement-breakpoint
CREATE INDEX "embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "chunks"."kind" <> 'parent';
