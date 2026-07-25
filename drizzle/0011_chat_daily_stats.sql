CREATE MATERIALIZED VIEW IF NOT EXISTS chat_daily_stats AS
SELECT
  date_trunc('day', created_at) AS day,
  mode,
  count(*) AS total,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_ms,
  avg(retrieve_ms) AS avg_retrieve_ms,
  avg(generate_ms) AS avg_generate_ms,
  count(*) FILTER (WHERE cache_hit) AS cache_hits,
  count(*) FILTER (WHERE out_of_domain) AS ood_count,
  count(*) FILTER (WHERE hallucination_blocked) AS hallucination_count,
  count(*) FILTER (WHERE ticket_created) AS tickets_created,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  count(DISTINCT user_id) AS unique_users
FROM chat_events
GROUP BY 1, 2
WITH DATA;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_daily_stats ON chat_daily_stats (day, mode);
