ALTER TABLE "ticket_audit" DROP CONSTRAINT "ticket_audit_action_check";--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "document_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_deleted_at_idx" ON "documents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "documents_uploaded_at_idx" ON "documents" USING btree ("uploaded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
ALTER TABLE "ticket_audit" ADD CONSTRAINT "ticket_audit_action_check" CHECK ("ticket_audit"."action" IN ('create','assign','status_change','note','impersonation','role_change'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" IN ('created','in_progress','closed'));