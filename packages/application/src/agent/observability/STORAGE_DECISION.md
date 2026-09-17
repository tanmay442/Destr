# WP-7 Storage Decision: Agent Observability (OBS-1)

Status: decided, no migration created.

## Decision

Use the hybrid split from `docs/agent-observability-admin-visibility-spec.md`
Section 14.1:

| Data class | Home |
|---|---|
| Compact terminal turn summary | Existing primary Postgres analytics path (`chat_events`) |
| Low-cardinality counters and histograms | Metrics backend |
| Detailed sanitized spans and tool/search traces | Sampled external trace store behind a `TraceStore` port |
| Background judge work | Existing durable queue capability |
| Hourly/daily admin trends | Narrow rollup store, rebuildable from retained sources |
| Audit and user-linked business facts | Existing approved Postgres/audit path |

## Explicitly not done in WP-7

- No migration created. No new database table added.
- No per-step event table in the primary database.
- Full trajectory event JSONB is not stored in `chat_events.meta`.
  JSONB remains acceptable only for sparse, backward-compatible annotations.
- The `InMemoryTraceWriter` in `trace-writer.ts` is a bounded synchronous
  buffer for tests and composition, not a persistence mechanism.
  Buffering, batching, sampling, persistence, retries, and vendor adaptation
  belong in infrastructure adapters behind project-owned ports.

## Why

At the target scale, per-step trace rows in the primary transactional database
would create write amplification, wide-row growth, expensive indexes and scans,
and retention coupling against chat/search traffic. Lossless compact turn
summaries stay in Postgres; sampled detailed traces live behind the port with
independent retention.

## Follow-ups required before any primary-DB event table

Separate migration approval, production-scale benchmark evidence, online rollout
plan, rollback or forward-repair plan, and owner sign-off. See the database
change register in spec Section 14.2.

## Secret-free

This record contains no credentials, personal data, or production transcripts.
