CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text,
	CONSTRAINT "audit_events_kind_check" CHECK ("audit_events"."kind" IN ('document','ticket','user','settings'))
);
--> statement-breakpoint
CREATE INDEX "audit_events_kind_idx" ON "audit_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_audit_events_source_ref" ON "audit_events" USING btree ("source_ref") WHERE "audit_events"."source_ref" IS NOT NULL;--> statement-breakpoint
-- Idempotent backfill from the legacy audit tables: source_ref dedup, per-row
-- verification before the drops, and a to_regclass guard so re-runs are no-ops.
DO $$
BEGIN
  IF to_regclass('public.document_audit') IS NOT NULL THEN
    INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
    SELECT 'document', action, actor_id, 'document', document_id::text, '{}'::jsonb, at, 'document_audit:' || id
    FROM document_audit
    ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM document_audit t
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'document_audit:' || t.id)
    ) THEN
      RAISE EXCEPTION 'Backfill verification failed for document_audit';
    END IF;
  END IF;

  IF to_regclass('public.ticket_audit') IS NOT NULL THEN
    INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
    SELECT 'ticket', action, actor_id, 'ticket', ticket_id, '{}'::jsonb, at, 'ticket_audit:' || id
    FROM ticket_audit
    ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM ticket_audit t
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'ticket_audit:' || t.id)
    ) THEN
      RAISE EXCEPTION 'Backfill verification failed for ticket_audit';
    END IF;
  END IF;

  IF to_regclass('public.user_audit') IS NOT NULL THEN
    INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
    SELECT 'user', 'role_change', actor_id, 'user', target_user_id,
      jsonb_build_object('fromRole', from_role, 'toRole', to_role), at, 'user_audit:' || id
    FROM user_audit
    ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM user_audit t
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'user_audit:' || t.id)
    ) THEN
      RAISE EXCEPTION 'Backfill verification failed for user_audit';
    END IF;
  END IF;

  IF to_regclass('public.document_audit') IS NOT NULL THEN DROP TABLE document_audit; END IF;
  IF to_regclass('public.ticket_audit') IS NOT NULL THEN DROP TABLE ticket_audit; END IF;
  IF to_regclass('public.user_audit') IS NOT NULL THEN DROP TABLE user_audit; END IF;
END $$;
