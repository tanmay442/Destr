ALTER TABLE "documents" DROP CONSTRAINT "documents_file_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "documents_file_name_unique" ON "documents" ("file_name") WHERE "deleted_at" IS NULL;
