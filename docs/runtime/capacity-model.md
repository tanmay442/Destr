# Runtime Capacity Model (WP-8, F-41)

Status: synthetic gate green; **real 4,000 / 20,000 results UNVERIFIED** until the
authorized non-production runs below are executed. Nothing in this document is
permission to run load against production.

## 1. Workload vocabulary

Bare "users" is never used. All envelopes are stated in one of:

| Term | Meaning |
|---|---|
| `active_turns` (C) | Turns holding an admission lease concurrently (Little's-law population) |
| `turn_starts_per_s` (λ) | Arrival rate; λ = C / W |
| `mean_turn_duration` (W) | Mean lease-hold time, scenario-weighted |
| `queued_turns` | Admitted to the bounded queue, awaiting promotion |
| `connected_clients` | Open SSE streams (superset of active turns) |

Profiles `average-4k` (C=4,000) and `peak-20k` (C=20,000) are defined in
`scripts/eval/workload-profile.ts` (`workloadProfiles`, schema `wp0-v3`).
The capacity subset used by the synthetic gate is the frozen mix:

| Scenario | Weight | Model calls | DB ops | Synthetic duration |
|---|---:|---:|---:|---:|
| `cache_hit` | 15% | 0 | 1 | 120 ms |
| `no_tool` | 25% | 1 | 2 | 1,400 ms |
| `one_search` | 40% | 2 | 6 | 3,800 ms |
| `two_search` | 20% | 3 | 12 | 6,400 ms |

Frozen mix source: `scripts/load/capacity-run.ts` (`FROZEN_MIX`, `SCENARIO_MODEL`).
Scenario-mix changes require re-freezing the mix and re-running the gate.

## 2. Little's-law resource math

Turn-start rate, model demand, token throughput, and DB demand derive from λ:

```text
λ = C / W
model_req_per_s      = λ × mean_model_calls_per_turn × (1 − answer_cache_hit_rate)
input_tokens_per_s   = λ × mean_total_step_input_tokens
output_tokens_per_s  = λ × mean_output_tokens
db_qps               = λ × mean_db_ops_per_turn
db_concurrency       ≈ db_qps × mean_db_service_s
pool_need            ≈ db_concurrency / target_utilization (0.5–0.65 for p95 ≤ 100 ms)
```

Sensitivity (illustrative, W = 3.168 s synthetic mean, 5.4 db ops/turn, 25 ms service):

| Active turns | λ (turns/s) | Model req/s (2.05 calls/turn) | DB ops/s | DB concurrency |
|---:|---:|---:|---:|---:|
| 100 | 32 | 65 | 170 | 4.3 |
| 500 | 158 | 324 | 853 | 21 |
| 1,000 | 316 | 648 | 1,706 | 43 |
| 4,000 | 1,263 | 2,589 | 6,820 | 170 |
| 20,000 | 6,313 | 12,942 | 34,090 | 852 |

Consequence: a 20-connection pool sustains ≈ 250 concurrent synthetic turns at
p95 ≤ 100 ms. 4,000 active turns need ≈ 170 concurrent DB slots (≈ 260+ pooled
connections at 65% utilization, or read-replica/batching relief) **plus**
matching provider RPM/TPM headroom. A larger pool alone never creates database
capacity — it must be paired with measured service time and CPU/cache-hit data.

## 3. Admission and shedding policy

Implementation: `packages/application/src/capacity/admission-control.ts`
(policy), `packages/infrastructure/src/capacity/distributed-turn-lease.ts`
(cross-instance leases), `packages/infrastructure/src/capacity/provider-admission.ts`
(provider/global ceilings + circuits).

- Per-user active-turn lease: 2, tenant-scoped, ownership-token, 120 s TTL with
  expiry recovery. The process-local map in `src/app/api/chat/slots.ts` remains
  fast-path only.
- Global and per-provider concurrency ceilings with a protected interactive
  reservation (background/judge work sheds first, never consumes it).
- Bounded queue (512) with 5 s queue deadline and interactive priority.
- Typed rejections with explicit Retry-After: `per_user_limit`, `global_limit`,
  `provider_limit`, `queue_full`, `queue_timeout`, `circuit_open`,
  `dependency_shedding`, `deadline_exceeded`, `rate_limited` → HTTP 429/503.
- Circuit breakers (closed/open/half-open) on provider 429/5xx/timeouts, DB pool
  wait, Redis errors, deadline-miss rate. All rejections happen **before**
  embeddings, model calls, or DB access.
- Distributed store outage fails closed (never silently degrades to per-instance
  state for correctness-critical admission).

## 4. Service quota inventory (fill before any real run)

| Service | Required quota/limit | Status |
|---|---|---|
| Vercel plan / region / Fluid / maxDuration / memory / burst ramp | measured per §7.14 | UNVERIFIED |
| Main/planner/grader/embedding/reranker RPM, TPM, concurrency | per-role values | UNVERIFIED |
| Neon compute min/max, pooled connections, PgBouncer queueing, CPU, cache-hit | provisioned tier | UNVERIFIED |
| Upstash Redis commands/s, latency p95, rate-limit cost | tier limits | UNVERIFIED |
| File descriptors per instance (70% ceiling at p99) | measured | UNVERIFIED |
| Paid cost ceiling per run | approved amount | REQUIRED before run |

No 4,000 run until every row is filled. No 20,000 run without separate
authorization (see §7).

## 5. SLOs and alerts

§12.6 steady-state thresholds (4,000 active, post-warmup, outside fault injection):

| Signal | Threshold | Alert |
|---|---|---|
| Typed admission (admitted or deliberate reject) | 100%, 0 ambiguous resets | page on any reset/5xx without Retry-After |
| Accepted → valid terminal | ≥ 99.9% | page below |
| Platform hard kills | 0 | page on any |
| Verified-answer release p95 | ≤ 20 s | warn above, page above 30 s |
| Provider throttle/error after admission | < 0.5% | page above |
| DB pool-wait p95 | ≤ 100 ms | warn above 50 ms, page above 100 ms |
| DB connection-limit errors | 0 | page on any |
| Interactive statement-timeout rate | < 0.1% | page above |
| Redis timeout/error rate | < 0.1% | page above |
| Background share of provider/DB | reservation only; interactive p95 delta ≤ 5% | page above |
| Queue depth / breaker state / judge backlog age | return to normal ≤ 5 min after load | page on stuck recovery |
| Progress payload p99 | ≤ 512 B, ≤ 1 non-terminal event/s/turn | warn above |

## 6. Rollback thresholds (automatic)

Roll back the admission/capacity flags when any of these hold for 3 consecutive
1-minute windows during rollout (1% → 5% → 25% → 50% → 100%):

- Deadline-exceeded terminal rate > 0.5% outside injected scenarios.
- Provider throttle-after-admission > 0.5%.
- DB pool-wait p95 > 100 ms or waiter-growth alert fires.
- Redis error rate > 0.1% with shedding engaged.
- Cost per completed turn > 120% of the synthetic projection for the mix.
- Any platform hard kill (`FUNCTION_THROTTLED`, timeout kill).

Rollback preserves correctness-critical idempotency; shedding policy may fall
back to fail-closed but never to unbounded admission.

## 7. Load authorization protocol

Real load runs ONLY via `scripts/load/load-agent.ts`:

```bash
pnpm load:agent --profile=average-4k --target=<approved-environment> \
  --identity=loadtest-<name> --duration-s=<30..2100> \
  --cost-ceiling-usd=<amount> --report=<path> [--execute]
pnpm load:agent --profile=peak-20k --target=<approved-environment> \
  --confirm-cost-cap=<amount> [...same required flags...]
```

- Production-like targets are always refused (no override exists).
- Unknown targets (absent from `LOAD_AGENT_ALLOWED_TARGETS`) are refused.
- Identities must be `loadtest-`-prefixed and bounded; duration is bounded;
  cost ceiling is mandatory.
- `peak-20k` additionally requires `LOAD_AGENT_PEAK_APPROVAL=1` plus a matching
  `--confirm-cost-cap` (separate authorization + paid approval).
- Without `--execute`, only a dry-run plan is written — never traffic.
- 20,000 is a separately authorized ramp/spike in a production-like
  environment with Vercel regional-burst ramp shape, monitoring, abort
  criteria, quotas, and cost approval. Never against production tenants or
  uncapped paid endpoints.

## 8. Evidence log

| Run | Command | Result |
|---|---|---|
| Synthetic gate (deterministic, virtual-clock) | `pnpm tsx scripts/load/capacity-run.ts --profile synthetic --seed 42` | PASS 14/14 (see `scripts/load/__tests__/capacity-run.test.ts` for the pinned subset) |
| Real average-4k soak (≥30 min post-warmup) | `pnpm load:agent --profile=average-4k …` | UNVERIFIED — awaiting approved environment + quotas + cost ceiling |
| Real peak-20k ramp | `pnpm load:agent --profile=peak-20k …` | UNVERIFIED — separately authorized, never without §7 |

Synthetic headline results (seed 42, 15,100 virtual turns, 28 stages — synthetic,
not capacity claims): accounting exact, 8 terminal kinds all typed with 0
ambiguous resets, queue bounded (max 16 outside the exhaustion probe),
non-fault pool-wait p95 19.5 ms, all 10 fault probes recovered on the synthetic
clock, judge backlog shifts interactive p95 by 0.14%, peak envelope degrades
gracefully (2,394 completed + 1,606 typed sheds at 4,000 on the 64-conn
synthetic tier).
