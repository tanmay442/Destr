DROP MATERIALIZED VIEW IF EXISTS chat_daily_stats;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS chat_daily_stats AS
SELECT
  date_trunc('day', created_at) AS day,
  mode,
  count(*) AS total,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_ms,
  avg(retrieve_ms) AS avg_retrieve_ms,
  avg(generate_ms) AS avg_generate_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p95_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY generate_ms) AS generate_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY generate_ms) AS generate_p95_ms,
  avg(max_similarity) AS avg_max_similarity,
  count(*) FILTER (WHERE cache_hit) AS cache_hits,
  count(*) FILTER (WHERE out_of_domain) AS ood_count,
  count(*) FILTER (WHERE hallucination_blocked) AS hallucination_count,
  count(*) FILTER (WHERE ticket_created) AS tickets_created,
  count(*) FILTER (WHERE NOT ticket_created AND NOT out_of_domain) AS self_serve_count,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  count(DISTINCT user_id) AS unique_users
FROM chat_events
GROUP BY 1, 2
WITH DATA;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_daily_stats ON chat_daily_stats (day, mode);
