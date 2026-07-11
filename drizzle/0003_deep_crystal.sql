CREATE TABLE "user_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"from_role" text NOT NULL,
	"to_role" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_audit_role_check" CHECK ("user_audit"."from_role" IN ('admin','user') AND "user_audit"."to_role" IN ('admin','user'))
);
