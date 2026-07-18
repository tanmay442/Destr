CREATE TABLE IF NOT EXISTS "audit_dead_letter" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"replayed" boolean DEFAULT false NOT NULL
);
