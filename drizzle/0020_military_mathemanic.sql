CREATE TABLE "quality_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"turn_id" uuid,
	"reviewer_id" text,
	"verdict" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_reviews_verdict_check" CHECK ("quality_reviews"."verdict" IN ('good','bad','docs_missing'))
);
--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_turn_id_chat_events_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."chat_events"("turn_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_reviewer_id_users_clerk_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("clerk_user_id") ON DELETE no action ON UPDATE no action;
