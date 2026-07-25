CREATE TABLE "chat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"query" text,
	"mode" text NOT NULL,
	"retrieve_ms" integer,
	"generate_ms" integer,
	"total_ms" integer,
	"hit_count" integer,
	"max_similarity" real,
	"out_of_domain" boolean DEFAULT false NOT NULL,
	"hallucination_blocked" boolean DEFAULT false NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"ticket_created" boolean DEFAULT false NOT NULL,
	"citation_count" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_events_mode_check" CHECK ("chat_events"."mode" IN ('agentic','vector'))
);
--> statement-breakpoint
CREATE INDEX "chat_events_created_at_idx" ON "chat_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_events_mode_idx" ON "chat_events" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "chat_events_user_id_idx" ON "chat_events" USING btree ("user_id");