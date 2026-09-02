DROP INDEX "documents_uploaded_at_id_idx";--> statement-breakpoint
CREATE INDEX "audit_events_at_id_idx" ON "audit_events" USING btree ("at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tickets_created_at_id_idx" ON "tickets" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_created_at_id_idx" ON "users" USING btree ("created_at","clerk_user_id");--> statement-breakpoint
CREATE INDEX "documents_uploaded_at_id_idx" ON "documents" USING btree ("uploaded_at" DESC NULLS LAST,"id" DESC NULLS LAST);