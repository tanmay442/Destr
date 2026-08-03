ALTER TABLE "chat_feedback" DROP CONSTRAINT "chat_feedback_turn_id_fkey";
--> statement-breakpoint
ALTER TABLE "chat_feedback" ADD CONSTRAINT "chat_feedback_turn_id_chat_events_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."chat_events"("turn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_kind_target_id_idx" ON "audit_events" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "chunks_document_id_chunk_index_idx" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "tickets_assigned_to_idx" ON "tickets" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "chat_feedback_created_at_idx" ON "chat_feedback" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_kind_check" CHECK ("chunks"."kind" IN ('parent','child','summary'));