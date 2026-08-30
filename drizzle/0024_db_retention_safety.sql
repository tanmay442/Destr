ALTER TABLE "app_settings" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "audit_dead_letter" ALTER COLUMN "attempted_at" SET DATA TYPE timestamp with time zone USING "attempted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "audit_dead_letter" ALTER COLUMN "attempted_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_seen_at" SET DATA TYPE timestamp with time zone USING "last_seen_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_dead_letter_attempted_at_idx" ON "audit_dead_letter" USING btree ("attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_dead_letter_replayed_idx" ON "audit_dead_letter" USING btree ("replayed") WHERE "audit_dead_letter"."replayed" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_events_meta_document_ids" ON "chat_events" USING gin ((("meta" -> 'documentIds')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_created_at_idx" ON "tickets" USING btree ("created_at" DESC NULLS LAST);