# Production database runbook

This runbook covers the PostgreSQL/pgvector database for one Destr deployment. A deployment owns one database and one deployment-wide knowledge corpus; do not use a shared database to combine customers. Runtime requests use the least-privilege `DATABASE_URL` role. DDL and migration work uses a separate owner/migration role through `MIGRATION_DATABASE_URL`.

## Safety and roles

- Take/verify a recent backup and point-in-time-recovery window before any migration, retention purge, partition operation, or index change. Confirm that an on-call operator can restore a clone.
- Never print `DATABASE_URL`, `MIGRATION_DATABASE_URL`, passwords, or provider tokens. Redact connection strings in tickets and command output.
- Production application connections need DML only. Keep DDL, extension, partition, and migration privileges on the migration role. Do not grant the application role ownership.
- Use a pooled Neon hostname for serverless application traffic (`-pooler` in the hostname), explicit `sslmode=verify-full` for Neon, and a deliberately sized `DATABASE_POOL_MAX`. Keep migration traffic on the direct owner URL when the provider recommends it.
- `pnpm db:push` is for local development and must not be used as a production migration or rollback mechanism. Production schema changes are forward-only reviewed migrations.

## Baseline and health check

Run the read-only scale diagnostic against a staging clone or read replica first. It records row estimates, relation/index sizes, index definitions, plans, retention-selection throughput, cancellation observation, and cache lease contention:

```bash
DATABASE_URL="$READ_ONLY_DATABASE_URL" \
  pnpm exec tsx scripts/scale-baseline.ts \
  --retention-days=90 --iterations=3 \
  --output="artifacts/db-baseline.json"
```

The script performs only `SELECT`, `EXPLAIN (ANALYZE, BUFFERS)`, and `pg_sleep` probes. Its purge-throughput section selects the current batch shape and never calls `DELETE`. `EXPLAIN ANALYZE` still consumes database CPU/IO, so schedule it away from peak traffic and set `--query-timeout-ms` for a bounded probe. If Upstash variables are both present, the cache section measures the distributed lease provider; with neither present it measures the in-process memory fallback. The report explicitly marks that the cache test is not cross-process.

Compare later reports using the same options and database role. Investigate before scaling when any of these trends are sustained: relation/index growth outpaces expected traffic, retention lag grows, dead tuples or autovacuum age rise, plans stop using the intended index, vector/lexical latency rises, lock waits increase, or cache lease errors appear. Timing thresholds belong to the service SLO and workload, not to this script or ordinary CI.

## Forward-only migration procedure

1. Review the migration SQL, generated snapshot, dependency-boundary impact, lock behavior, and rollback/forward-repair plan. Run `pnpm db:check` and the focused tests plus `pnpm gate` on the candidate revision.
2. Apply the migration from a controlled operator environment with the owner URL:

   ```bash
   MIGRATION_DATABASE_URL="$DDL_DATABASE_URL" pnpm db:migrate
   ```

   The migrator takes an advisory lock, applies each file transactionally where PostgreSQL permits it, and records the file hash. Watch active queries, lock waits, and error logs while it runs.
3. Re-run the baseline against the same database (or a clone) and retain the JSON report with the migration/change record. Verify application reads, ingestion, chat persistence, feedback, audit writes, and the scheduled purge path.
4. If a migration fails, do not edit the applied migration or delete migration history. Leave the previous schema intact where the transaction permits, capture the database error and lock evidence, and ship a reviewed forward repair migration. Restore from PITR only under the incident commander’s approved recovery plan.

For the high-growth identifier migration, run both disposable-database checks from an owner/migration connection before promotion. The verifier creates and force-drops temporary databases; use a local owner or a staging clone where `CREATEDB` is permitted:

```bash
MIGRATION_DATABASE_URL="$DDL_DATABASE_URL" pnpm db:verify-identifiers
```

The fresh check applies the complete migration chain. The upgrade check applies `0000`–`0027`, seeds all four legacy `id` columns, then applies the remaining migrations, verifies that seeded IDs and the final registry-backed foreign keys survive, and proves each owned sequence can generate `2,147,483,648`. Do not run it against a production database; the temporary database must be disposable.

## Retention and purge operations

The scheduled purge removes old `chat_events` and, when enabled, saved conversations/messages. Run a dry run first and record the cutoff and counts:

```bash
pnpm cli purge-chat-events --days=90 --dry-run
pnpm cli purge-chat-history --days=120 --dry-run
```

After confirming the retention policy, traffic window, backup, and counts, run the explicitly confirmed operation:

```bash
pnpm cli purge-chat-events --days=90 --yes
pnpm cli purge-chat-history --days=120 --yes
```

The repository deletes in bounded batches and removes dependent feedback/review rows before event rows. For chat history it locks candidate conversations with `SKIP LOCKED`, deletes message batches, then deletes still-eligible conversations. Do not issue an unbounded hand-written `DELETE` in production. If the purge is slow or blocked, stop the job, inspect `pg_stat_activity`/locks and retention lag, and resume with a smaller operational window after the cause is understood. Preserve the purge output and audit record; a failed audit write must be treated as an incident even if data deletion completed.

## Query cancellation

The database search adapters use lazy execution: an already-aborted request does not start a query, and an abort that races query startup is checked again before dispatch. On plain node-postgres, each signal-bearing operation checks out one connection, records its backend PID, and sends `pg_cancel_backend` from a separate physical connection on abort. The original connection remains checked out until both the query and cancellation request settle, so a late cancel cannot hit a later pool borrower. The separate connection also avoids deadlock when the application pool maximum is one. Runtime pools retain a 30-second `statement_timeout` as a final backstop.

Run `packages/infrastructure/src/db/query-cancellation.test.ts` against local PostgreSQL after driver or pool changes. It repeats `pg_sleep(10)`, requires cancellation within three seconds, confirms the probe query is absent from `pg_stat_activity`, and verifies a subsequent query succeeds. Neon serverless HTTP/WebSocket execution does not expose a stable backend PID through the current adapter; Neon therefore retains lazy pre-abort prevention and the statement timeout, and immediate server-side cancellation is not claimed for Neon. Do not replace the owned-connection adapter with a promise race that releases the backend before its query settles.

For GDPR requests, use the authenticated application operation so ownership, feedback, tickets, audit rows, and saved chats follow the same contract. Verify the returned counts and audit/dead-letter outcome. Do not delete by email or by an unverified identity.

## Signed pagination cursor rotation

Each deployment must set `CURSOR_SIGNING_SECRET` to a random value of at least
32 UTF-8 bytes before enabling production traffic. The application validates
this during composition startup and never logs the value. To rotate, deploy
the new value as `CURSOR_SIGNING_SECRET` and the old value as
`CURSOR_SIGNING_PREVIOUS_SECRET`; leave the previous value configured for at
least the configured `CURSOR_TTL_SEC` window, then remove it in a follow-up
deployment. A cursor signed by either key is accepted only when its resource,
normalized filter binding, sort, and expiry match the request. Unsigned v1,
tampered, mismatched, and expired cursors return 400; operators should not
work around these responses by resetting the page query.

## Physical partitions and lifecycle procedure

Migration `0029_physical_partitions` implements the accepted layout in
`docs/adr/0002-production-scale-data-layout.md`:

- `chat_messages` uses 32 fixed hash partitions on `conversation_id`, with a
  composite `(conversation_id, id)` primary key and the existing
  `(conversation_id, turn_id, role)` uniqueness. Conversation reads and retry
  deletes include the conversation key, so they can prune to one hash
  partition. There is no per-conversation DDL.
- `chat_events` uses monthly range partitions on `created_at` and
  `audit_events` uses monthly range partitions on `at`. Each has a composite
  `(id, partition_key)` primary key. A small unpartitioned `chat_turns` registry
  keeps `turn_id` globally unique and is the foreign-key target for events,
  feedback, and quality reviews. Database triggers register turns atomically,
  reject duplicate or mutated turn keys, and remove the registry row after the
  event and its dependent rows are deleted.
- Both range parents have a monitored `*_default` emergency partition. A row
  there means a writer arrived outside provisioned coverage; it is not a
  normal retention path. `audit_events.source_ref` remains only as historical
  backfill data; its old global unique index is intentionally retired because
  PostgreSQL cannot enforce a unique key that omits a range partition key.
  Runtime audit writes never use it.

The migration has transaction-local preflight/postflight checks, a bounded
`lock_timeout`, temporary source copies, sequence high-water preservation, and
materialized-view recreation. It validates row counts, registry coverage,
partition parents, and empty defaults before commit. It is forward-only: never
edit or delete an applied migration. A failed transaction should leave the
previous schema intact; if an operational change fails after commit, retain
the old objects/backup and ship a reviewed forward repair migration or restore
from PITR under the incident plan rather than hand-editing migration history.

### Provisioning future partitions

Run the owner-only lifecycle tool from a controlled operator environment. It
requires `MIGRATION_DATABASE_URL`, refuses `rag_app`, takes the migration
advisory lock, sets bounded lock/statement timeouts, creates the current month
plus at least six future monthly partitions idempotently, and verifies the
parent indexes. It never prints the connection string or password.

```bash
# Read-only coverage/default/index report (safe first step)
MIGRATION_DATABASE_URL="$DDL_DATABASE_URL" pnpm db:partitions -- --dry-run

# Apply only after confirming the exact database name printed by the dry run
MIGRATION_DATABASE_URL="$DDL_DATABASE_URL" pnpm db:partitions -- \
  --apply --confirm-database="$PGDATABASE"
```

`--confirm-database` is mandatory for writes; `--months-ahead` may be raised
but cannot be lowered below six. The tool reports missing coverage and rows in
`chat_events_default`/`audit_events_default`; it refuses an apply while either
default contains rows unless `--allow-default-rows` is explicitly supplied
after an operator has diagnosed the gap. A missing monthly partition is a
correctness incident: isolate or pause the writer, run the tool, replay failed
writes, and drain the default partition into the correct month before normal
traffic resumes.

After provisioning, run `ANALYZE chat_events`, `ANALYZE audit_events`, and
`ANALYZE chat_messages` when a large load or partition change makes statistics
stale. Monitor child index size, dead tuples, autovacuum/analyze age, lock
waits, default rows, and the oldest unretained partition. Hot partitions need
autovacuum settings appropriate to the write rate; index rebuilds must be
scheduled owner operations and must not use `CREATE INDEX CONCURRENTLY` inside
the transactional migration runner.

Use a time predicate to verify pruning; partitioning does not improve a query
that omits its partition key:

```sql
EXPLAIN (COSTS OFF)
SELECT count(*) FROM chat_events
WHERE created_at >= TIMESTAMPTZ '2026-09-01'
  AND created_at <  TIMESTAMPTZ '2026-10-01';

EXPLAIN (COSTS OFF)
SELECT id, role, content FROM chat_messages
WHERE conversation_id = '00000000-0000-0000-0000-000000000001'
ORDER BY id;
```

### Retention, detach, and recovery

The application purge remains the default retention path: it deletes feedback
and reviews before event rows in bounded transactions; the registry trigger
then removes only turn rows whose event is gone. For large historical windows,
an owner may detach one fully expired monthly child only after recording a
backup/PITR point, row counts, dependent feedback/review counts, and the
retention cutoff. Do not drop a child while registry or dependent rows remain.
Keep a detached child through the recovery window, validate the restored clone,
then drop it in a separately reviewed operation. If detach/drop or a partition
attach fails, stop the destructive step, preserve the object, capture lock
evidence, and roll forward with a repair migration; rollback means restoring
the pre-operation backup/PITR image, not reversing an applied migration file.

## Incidents and escalation

Capture the database name, deployment, migration hash, UTC timestamps, query/transaction identifiers, lock graph, affected relation/partition, and redacted configuration. Never include credentials or message contents in incident notes. Escalate to the database/provider owner when there is sustained connection exhaustion, failed PITR/restore, replication/Neon endpoint trouble, missing partitions, unexplained foreign-key violations, or a purge that cannot make progress without risking user traffic.
