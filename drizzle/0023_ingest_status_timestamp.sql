ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ingest_updated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_ingest_status_updated_idx" ON "documents" USING btree ("ingest_status", "ingest_updated_at") WHERE "deleted_at" IS NULL;
