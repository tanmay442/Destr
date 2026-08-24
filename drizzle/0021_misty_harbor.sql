-- Fix quality_reviews FKs to unblock GDPR purge and 90-day retention (SEC-H1/DB-F1).
-- Decision: turn_id ON DELETE CASCADE mirrors chat_feedback (delete reviews with their turn);
-- reviewer_id ON DELETE CASCADE chosen for simplicity (alternative SET NULL would preserve
-- verdicts and require UPDATE anonymization; CASCADE keeps purge CTEs uniform and matches
-- audit P0's "CASCADE or SET NULL" allowance; column is already nullable so SET NULL would
-- also be valid without schema change).
ALTER TABLE "quality_reviews" DROP CONSTRAINT "quality_reviews_turn_id_chat_events_turn_id_fk";--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_turn_id_chat_events_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."chat_events"("turn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" DROP CONSTRAINT "quality_reviews_reviewer_id_users_clerk_user_id_fk";--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_reviewer_id_users_clerk_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("clerk_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quality_reviews_turn_id_idx" ON "quality_reviews" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "quality_reviews_reviewer_id_idx" ON "quality_reviews" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "quality_reviews_created_at_idx" ON "quality_reviews" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_reviews_turn_reviewer_unique" ON "quality_reviews" USING btree ("turn_id","reviewer_id");--> statement-breakpoint
UPDATE "quality_reviews" SET "verdict" = 'good' WHERE "verdict" IS NULL;--> statement-breakpoint
ALTER TABLE "quality_reviews" ALTER COLUMN "verdict" SET NOT NULL;
