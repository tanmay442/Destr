ALTER TABLE "documents" ALTER COLUMN "uploaded_at" TYPE timestamptz USING "uploaded_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_uploaded_at_id_idx" ON "documents" USING btree ("uploaded_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL;
