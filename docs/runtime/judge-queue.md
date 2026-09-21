# Durable Judge Queue and Worker Operation (WP-8 F-39)

Secret-free. No credentials, personal data, production transcripts, or
proprietary document content. Environment variable names are documented;
values never are.

Source of truth is code, not this document. On any conflict the modules win:
`src/composition.ts` (`resolveJudgeWorkerUrl`, `createJudgeQueue`),
`src/app/api/chat/handler.ts` (handler seam), `src/app/api/chat/judge.ts`
(scheduler + dispatch), `src/app/api/chat/judge-queue-port.ts` (route adapter),
`src/app/api/queue/judge-worker/route.ts` (consumer),
`packages/application/src/capacity/background-queue.ts` (job codec),
`packages/infrastructure/src/capacity/background-job-queue.ts` (queue +
QStash publish), `packages/application/src/runtime/wp8-flags.ts`
(`durableJudgeQueue` flag). Flag semantics also mirror
`docs/runtime/wp8-flags-rollback.md`.

---

## 1. Composition (`createJudgeQueue` / `resolveJudgeWorkerUrl`)

`src/composition.ts` builds one process-wide `judgeQueue`
(`DurableBackgroundJobQueue`) plus a `judgeQueueRemotePublish` boolean, both
wired into the composition object (`judgeQueue` field).

### Worker URL resolution (`resolveJudgeWorkerUrl`)

Precedence, first non-empty value wins:

1. `QSTASH_JUDGE_WORKER_URL` (trimmed, trailing slashes stripped).
2. Origin of `NEXT_PUBLIC_APP_URL` (unparseable values are skipped).
3. `https://<VERCEL_URL>` (any leading scheme is normalized away).
4. Empty string — no remote consumer is reachable.

### Remote publish attaches only when token + URL are both present

`createJudgeQueue` (`src/composition.ts`) attaches QStash publish only when
`QSTASH_TOKEN` is non-empty **and** the resolved worker URL is non-empty:

- Both present: queue constructed with
  `createQstashPublish({ url: '<worker-url>/api/queue/judge-worker', token })`,
  `remotePublish: true`. The publish function sends `retries: 3` and uses the
  job idempotency key as the QStash `deduplicationId`
  (`packages/infrastructure/src/capacity/background-job-queue.ts`,
  `createQstashPublish`). `createJudgeQueue` does not wire a `dlqUrl` (the
  infra publish supports one, the judge composition omits it), so there is no
  judge DLQ endpoint — exhausted QStash deliveries are not forwarded anywhere
  (contrast the ingest path's `QSTASH_DLQ_URL`).
- Otherwise: queue constructed with no publish function,
  `remotePublish: false`. Construction never throws — a misconfigured queue
  degrades to the same posture as no queue (a warning is logged).

Two non-remote postures follow from the queue implementation:

- No `QSTASH_TOKEN`: mode resolves to `disabled-safe`
  (`resolveBackgroundJobMode`) and enqueues shed observably with reason
  `disabled`; the judge seam falls back inline (see §2).
- Token set but no worker URL: the job is buffered in-process and drained by
  the inline pump with `durable: false` (no remote ownership); the local pump
  still applies bounded concurrency, retries, dead-lettering, and backlog
  accounting.

The in-process pending set is a dispatch buffer, never the durability story.
Durability across suspension comes from QStash delivery, not from memory.

---

## 2. Handler seam (flag `WP8_DURABLE_JUDGE_QUEUE_ENABLED`, default off)

The flag is defined in `packages/application/src/runtime/wp8-flags.ts`
(`durableJudgeQueue`): owner evaluation on-call, `defaultEnabled: false`,
unrecognized values fail safe to the default. The chat handler
(`src/app/api/chat/handler.ts`) reads it per request via `readWp8Flag`.

### Flag off (default): pre-WP-8 behavior, unchanged

No queue port is constructed, no inline worker is registered; the judge
scheduler defers through `scheduleAfter` (Next `after()` with a direct-call
fallback) and the quality-judge dispatch runs inline — identical to
the pre-WP-8 path.

### Flag on: durable path with inline fallback

- A route-layer port is built over the composition queue
  (`createJudgeQueuePort(comp.judgeQueue, { remotePublish:
  judgeQueueRemotePublish })`), and the inline handler is registered
  once per process (`ensureJudgeWorker`).
- `createQualityJudge` enqueues a serializable judge job
  (`kind: 'judge'`, `turnId`, flat string-map payload via
  `encodeJudgePayload`). Enqueue throws or sheds (`queue_full`, `paused`,
  `disabled`, `interactive_pressure`, `remote_unavailable`) → the seam logs
  (`judge.durable.enqueue_failed` /
  `judge.durable.shed_fallback_inline`) and runs inline, so sampling
  degrades visibly instead of dropping silently.
- `createJudgeScheduler` runs the enqueue task, then pumps the queue so
  bounded concurrency, retries, dead-lettering, and backlog-age apply —
  **unless** the per-request durability outbox reports a remote worker owns
  the job (`reportDurable(true)` → `isDurable()`), in which case the local
  pump is skipped so one sampled turn never pays for two judge runs. Pump
  failures are observed (`judge.durable.pump_failed`), never fatal.
- Malformed payloads are dropped with a warning
  (`judge.worker.invalid_payload`), never partially executed.

---

## 3. Consumer (`src/app/api/queue/judge-worker/route.ts`)

### Signature verification

- Both `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` are
  required; either missing → `401`. Verification uses QStash `Receiver.verify`
  with the raw bounded body, mirroring the ingest-worker route. There is no
  admin session on this path.
- A 5-minute replay window is enforced on the signature `iat` in both
  directions (stale or future-dated signatures → `401`).
- Body cap is 256 KiB (`413` when exceeded); invalid JSON, non-`judge` kind,
  missing `turnId`, or undecodable payload → `400`. Validation failures are
  non-retryable by status; `runJudge` catches scoring failures internally, so
  valid jobs return `200` after overwriting the turn's scores. `500` only
  escapes on unexpected throws outside `runJudge` (e.g. composition failure),
  in which case QStash retries within its budget (`retries: 3`).

### Idempotency

The turn ID is the idempotency key end to end:

- Job identity is deterministic per turn (`judgeJobId` → `judge-<turnId>`;
  `judgeIdempotencyKey` → `judge-turn:<turnId>` in
  `packages/application/src/capacity/background-queue.ts`).
- Repeat deliveries collapse on the enqueue/pump path: pending duplicates
  return `duplicate` via the idempotency-key index; remotely delivered keys
  are retained (bounded, 5000) so repeats still collapse instead of
  republishing; the route adapter maps a remote-mode duplicate to
  `durable: true` (no local pump needed) and a buffer-mode duplicate to
  `durable: false` (the pending original still needs its pump). Scope note:
  the remote consumer route itself (`POST`, see above) does not consult the
  queue — it executes `runJudge` directly — so repeat QStash deliveries
  re-execute rather than collapsing to `duplicate`; repeats stay safe only
  via the overwrite-converges behavior below.
- Execution is safe under at-least-once delivery: `runJudge` scores
  relevance + faithfulness and overwrites the same turn's `judgeScores`
  (buffered batcher patch first, persisted event-meta patch otherwise, with
  one bounded 5-second meta retry), so repeats converge rather than
  duplicate.

### Retry semantics

- Remote (QStash): `retries: 3` with `deduplicationId` set to the idempotency
  key; publish failure sheds locally as `remote_unavailable` and the seam
  falls back inline.
- Local pump: the caller drives `pump()` deterministically (no timers) up to
  the bounded concurrency limit (default 4). A throwing handler is retried
  until the job's `maxAttempts` (default 3), then moved to dead-letter. A job
  with no registered handler goes directly to dead-letter
  (`judge_unavailable`).
- Payload codec bounds are enforced at both ends (question/documents ≤
  100 KiB, answer ≤ 50 KiB, ≤ 50 snippets of ≤ 20 KiB each); oversized inputs
  throw at encode time so the caller falls back inline instead of enqueueing
  work the worker would drop.

---

## 4. Backlog and dead-letter observability

`DurableBackgroundJobQueue.stats()` exposes, all in-process:

- `mode` (`qstash` | `disabled-safe`), `depth`, `judgeDepth` (judge sub-cap,
  default 500 of 1000 total), `inFlight` / `maxConcurrent` (default 4).
- Cumulative counters: `enqueuedTotal`, `dispatchedTotal`, `completedTotal`,
  `shedTotal`, `duplicateTotal`, `deadLetterTotal`, `remotePublishFailures`,
  `remoteDeliveredTotal`.
- `oldestAgeMs` and `backlogStale` (true when the oldest pending job exceeds
  `maxBacklogAgeMs`, default 900 000 ms / 15 min) — the signal behind the
  `judge_backlog_age` flag metric.
- Control state: `paused`, `disabled`, `interactivePressure`.

Structured log events (never carrying payload content):

- `capacity.background.enqueued` / `.shed` (with `reason`: `paused`,
  `disabled`, `queue_full`, `interactive_pressure`, `judge_unavailable`,
  `remote_unavailable`) / `.retry_scheduled` / `.dead_letter` /
  `.remote_publish_failed` / `.paused` / `.disabled` /
  `.interactive_pressure`.
- `judge.durable.enqueue_failed`, `judge.durable.shed_fallback_inline`,
  `judge.durable.pump_failed`, `judge.worker.invalid_payload`,
  `judge.enqueue.meta_retry_scheduled`, `judge.enqueue.meta_retry_failed`,
  `judge.enqueue.failed`.

Dead-letter storage is in-process (bounded at 500 entries) and the
composition does **not** wire a persistent `recordDeadLetterHook`, so dead
letters are visible via `stats().deadLetterTotal` and logs only. There is no
admin UI surface for the judge backlog or dead letters.
TBD: persist judge dead letters (e.g. wire the hook to `audit_dead_letter`)
and expose backlog age where on-call looks before relying on the durable
path in production.

---

## 5. Safe rollout and rollback

- Default posture is off and safe: unset or unrecognized
  `WP8_DURABLE_JUDGE_QUEUE_ENABLED` resolves to disabled, and removing
  `QSTASH_TOKEN` reverts to shed-plus-inline-fallback without a code change.
- Suggested rollout: keep the flag off while verifying inline behavior;
  enable for internal traffic with judges observed via the counters above;
  stage wider only with `judge_backlog_age`, `judge_completion_drop_rate`,
  and `interactive_p95_delta_with_judges_enabled` green. Judges shed before
  interactive work under pressure (`interactive_pressure` sheds judge jobs
  first), and background judging can be paused/disabled independently
  (`pause()` / `disable()`) without affecting interactive turns.
- Rollback: set `WP8_DURABLE_JUDGE_QUEUE_ENABLED=0` and restart. Rollback
  preserves grounding policy, approval policy, idempotency, error
  classification, score provenance, budgets, and overload safety
  (`WP8_ROLLBACK_PRESERVED_INVARIANTS`).
- Automatic rollback thresholds (flag definition): background work raising
  interactive p95 latency by more than 5%, or judge backlog age exceeding
  its alert threshold without recovery in 5 minutes.
- TBD (verify before enabling remote publish in production):
  `src/app/api/queue/judge-worker/route.ts` enforces its own QStash
  signature, but `/api/queue/judge-worker` is not listed in the Clerk
  middleware public routes
  (`packages/infrastructure/src/auth/clerk-adapter.ts`), whose unmatched-API
  branch returns `401`. Confirm the route is reachable by QStash (middleware
  exemption or equivalent) or remote deliveries will fail closed before
  signature verification runs.
