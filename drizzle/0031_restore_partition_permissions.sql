-- Restore application role (rag_app) permissions, RLS policies, and default
-- privileges on partitioned tables and materialized views recreated in migration 0029.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rag_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rag_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rag_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rag_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rag_app;

    ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chat_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE quality_reviews ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_events' AND policyname = 'rag_app_full_access') THEN
      CREATE POLICY rag_app_full_access ON audit_events FOR ALL TO rag_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_events' AND policyname = 'rag_app_full_access') THEN
      CREATE POLICY rag_app_full_access ON chat_events FOR ALL TO rag_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'rag_app_full_access') THEN
      CREATE POLICY rag_app_full_access ON chat_messages FOR ALL TO rag_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_turns' AND policyname = 'rag_app_full_access') THEN
      CREATE POLICY rag_app_full_access ON chat_turns FOR ALL TO rag_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quality_reviews' AND policyname = 'rag_app_full_access') THEN
      CREATE POLICY rag_app_full_access ON quality_reviews FOR ALL TO rag_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;
--> statement-breakpoint
REFRESH MATERIALIZED VIEW chat_daily_stats;
