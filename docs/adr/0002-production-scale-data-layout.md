# Production-scale data layout

Status: accepted

Destr keeps one customer per deployment: each deployment owns its identity provider, PostgreSQL database, blob store, Redis data, queue, and deployment-wide knowledge corpus. The production target is one deployment with up to roughly 8 million users, millions of conversations, potentially billions of chat messages/events, and hundreds of thousands to millions of RAG chunks. Migration `0029_physical_partitions` implements bounded physical partitioning for the measured high-growth shapes while retaining PostgreSQL-enforced ownership, feedback, review, and global turn invariants.

## Data growth and ownership

High-growth tables are `chat_messages`, `chat_events`, `audit_events`, and `quality_reviews`; `tickets` may also become high-growth as support volume increases. Medium-growth tables are `documents`, `chunks`, and `chat_conversations`. The deployment boundary is the isolation boundary, so no optional tenant key is required in every query. `documents` and `chunks` remain the source of truth for the shared knowledge corpus; saved conversations and feedback remain owned by their `user_id`.

Migration `0028_high_growth_identifier_width` widens the sequence-backed primary keys of `chat_events`, `audit_events`, `quality_reviews`, and `tickets` to PostgreSQL `bigint` while retaining their sequences, defaults, ordering keys, and foreign-key relationships. The application uses Drizzle's safe numeric mode and rejects values outside JavaScript's `Number.isSafeInteger` range before they cross JSON, cursor, or batch-delete boundaries; it never emits a raw JavaScript `bigint`. `documents.id`, `chunks.id`, `chunks.document_id`, `chunks.parent_chunk_id`, and the integer document/chunk reference arrays remain `int4` because this deployment's documented corpus operating ceiling is millions of rows and remains below `2,147,483,647`; widening them is a separately reviewed change that must migrate all related references together, with high-water alerts before the ceiling is approached.

## Decision and implemented partition layout

1. Keep the existing indexes and use `scripts/scale-baseline.ts` for before/after evidence. Migration `0029_physical_partitions` uses monthly range partitions for append-only `chat_events` and `audit_events`, and 32 fixed conversation-hash partitions for `chat_messages`. Time predicates are required for time-partition pruning; partitioning does not improve a query that omits the partition key.
2. `chat_messages` has a composite `(conversation_id, id)` primary key and retains `(conversation_id, turn_id, role)` uniqueness. Its fixed hash count keeps a conversation together without creating one partition per conversation; conversation loading, retry replacement, and purge lookups include `conversation_id`.
3. `chat_events` has monthly `created_at` partitions and `audit_events` has monthly `at` partitions. Each parent has a partition-compatible `(id, partition_key)` primary key and an emergency default child that is monitored and expected to remain empty. An owner-only lifecycle tool maintains the current month plus at least six future months.
4. Global turn semantics use the non-partitioned `chat_turns(turn_id PRIMARY KEY, created_at, user_id)` registry. Database triggers register a turn atomically before event insertion, serialize and reject duplicate turn events, make `turn_id`/`created_at` immutable, and clean registry rows after dependent event deletion. `chat_events`, `chat_feedback`, and `quality_reviews` reference the registry with real foreign keys; callers do not route by partition name.
5. Do not partition `chunks` by document by default. Document-specific retrieval and re-ingest have a document key, but creating a partition per document would produce an unbounded partition count and expensive DDL/planning. Existing `document_id`/`chunk_index`, lexical, and vector indexes are the first-line design. A bounded hash layout can be reconsidered only if measurements show a query-pruning or maintenance benefit. `tickets` remains unpartitioned mutable workflow data.

Partitioned-table unique constraints and primary keys must include the partition key in PostgreSQL. The implemented registry design is therefore the source of global `turn_id` uniqueness. `chat_feedback` and `quality_reviews` retain a validated foreign-key path to the canonical turn; disabling the foreign keys or relying on application-only checks is not acceptable. `audit_events.source_ref` was verified to be used only by the historical legacy backfill and is not accepted by runtime audit writes, so its pre-partition global unique index is retired rather than weakened to a misleading per-partition uniqueness rule.

## Partition lifecycle and operations

Create future time partitions ahead of the retention horizon (at least six months) with the owner-only `scripts/manage-partitions.ts` tool. Partition creation, index attachment, and constraint validation must be rehearsed on a production-sized clone and scheduled with lock/latency observation. A missing time partition is a correctness incident: stop or isolate the writer, run the tool, and replay/retry failed writes. The default partition is an explicitly monitored emergency buffer with a documented drain procedure, never a silent retention fallback.

Retention should delete dependent feedback/review rows before removing event rows, or detach and drop a partition only after dependency checks prove it safe. Record the cutoff, partition, row counts, duration, and failures in the audit/operations trail. Monitor partition coverage, rows and bytes per partition, index bytes, autovacuum/analyze age, dead tuples, long-running transactions, lock waits, retention lag, failed writes, and any rows in an emergency default partition. If a partition operation fails, leave the old data intact, pause the destructive step, preserve the error and lock evidence, and use a forward repair migration after review.

The application role remains least-privilege; only the migration/operations role creates, attaches, detaches, or drops partitions. Database backups/PITR and a tested restore are prerequisites for destructive retention changes. `scripts/scale-baseline.ts` is a read-only evidence tool: its purge measurement selects batches only and never issues `DELETE`.

## Options considered

| Option | Decision | Reasoning and pruning requirement |
| --- | --- | --- |
| No partitioning, indexes only | Current baseline | Lowest migration and foreign-key risk. Works while measurements show acceptable plans, vacuum, index size, and retention throughput. Indexes cannot solve every write/bloat/retention problem at the target scale. |
| Time-range partitioning | Leading candidate for append-only events | Makes time-bounded retention and recent analytics prune naturally when queries include `created_at`/`at`; adds partition lifecycle, lock, and cross-partition uniqueness work. A query without a time predicate still scans partitions. |
| Hash partitioning | Candidate for `chat_messages` | Bounds partition count and spreads conversation writes when queries include `conversation_id`; it does not help global time analytics or queries without the hash key. |
| Multi-level time plus hash partitioning | Deferred | Can combine retention pruning and write distribution, but multiplies partition/index/DDL/monitoring complexity. Adopt only after single-level measurements identify both independent bottlenecks. |
| Dedicated event/vector stores | Rejected as the primary source of truth for now | Adds consistency, replay, retention, and operational systems. PostgreSQL keeps transactional feedback, audit, and chat relationships together; a dedicated analytics/vector store may be added later as a derived, replayable read model when a measured workload requires it. |

## Database-level sharding path

The deployment boundary already supplies a natural first routing key: a customer deployment can move to its own database without cross-deployment joins. Stable `document_uid`/`chunk_uid`, UUID conversation and turn identifiers, explicit ownership fields, and append-only event timestamps should be preserved so a future router can map a deployment or a bounded conversation hash range to a shard. Cross-shard analytics must then be asynchronous/derived, while per-deployment retrieval, conversation loading, feedback, and audit invariants remain local to one shard. Partitioning is therefore an internal optimization and must not become an implicit substitute for a documented shard-routing contract.
