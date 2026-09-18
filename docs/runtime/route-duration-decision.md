# WP-8 Route-Duration Decision Record (F-31)

Status: **keep `maxDuration = 60`** (no deployment change, no remote config change).

## Re-inspection evidence (read-only, 2026-09-18)

- `src/app/api/chat/route.ts`: `maxDuration = 60`, with a build assertion that it
  equals `CHAT_ROUTE_MAX_DURATION_SECS` and that `ROUTE_ENVELOPE_CURRENT_60`
  (60s platform / 50s app hard stop / 10s reserve) validates.
- `packages/domain/src/constants.ts`: `MAX_DURATION_MS = 60_000`.
- Turn seam (`chat-turn/turn.ts`): soft deadline defaults to 50,000 ms
  (`CHAT_SOFT_DEADLINE_MS`), clamped to at most 55,000 ms; the WP-5
  `AgentRunBudget` now derives from the WP-8 deadline ledger's absolute
  `deadlineAt` with reserve `min(15_000, softDeadlineMs)` — identical values,
  new ownership.
- Reserve-floor finding: the 55 s clamped path leaves a 5 s tail reserve,
  below the `max(10 s, 10% platform)` floor. The ledger still refuses new work
  that cannot fit its expected duration plus the reserve; the clamp is
  preserved verbatim for rollback safety, not endorsed as a target.
- Vercel link: `.vercel/project.json` confirms project `rag_agent`
  (`prj_myHlmCxmI2XIgTQSkeOsneQejA39`); plan/region/Fluid were **not**
  re-queried (no CLI auth in this environment), so the planning snapshot
  (region `iad1`, Fluid enabled, Node 24.x per plan §5.4) is carried as
  snapshot evidence, not fresh proof. Local runtime is Node 26.7.0; framework
  `next@16.2.11`; AI SDK pinned at `ai@6.0.221` (WP-10 excluded).
- Synthetic gate (deterministic, seed 42): 14/14 PASS — worst non-fault
  pool-wait p95 4.0 ms (≤100 ms gate), max progress event 384 B (≤512 B),
  zero ambiguous resets, zero hard kills in virtual time. This exercises
  mechanics, not production capacity; real 4k/20k remain UNVERIFIED.

## Comparison

| Profile | Platform | App stop | Reserve | Occupancy/tail | Verdict |
|---|---|---|---|---|---|
| Current 60 | 60 s | 50 s | 10 s | Baseline; tail work (grounding, cache publish, persistence, lease release, stream close) must fit 10 s | **Keep** |
| Candidate 90/75/15 | 90 s | 75 s | 15 s | +50% max memory-time per tail; longer queue occupancy under overload; does not raise model/tool/search/evidence/token/retry/cost budgets (ledger pins counts) | Rejected without 4k soak + downstream quotas + cost approval |
| Provisional 120/105/15 | 120 s | 105 s | 15 s | 2× max occupancy; amplifies queue collapse and cost under provider/DB saturation | Rejected without 4k soak + 20k plan + quotas + cost approval |

Downstream effects considered: Vercel burst ramp (1,000 concurrent/10 s regional),
1,024 FD/instance ceiling shared by DB/Redis/provider sockets, Neon pool queueing,
Upstash coordination latency, provider RPM/TPM/concurrency quotas, SSE byte/event
rate at 4k–20k streams, and memory-time cost. A longer envelope widens the kill
boundary but increases resource occupancy and overload amplification; the
capacity gates (§12.6) reject any increase that improves completion only via
deeper queues or higher p99 occupancy/cost.

## Decision

- Keep 60 s. Any increase is independently controlled by
  `WP8_ROUTE_DURATION_INCREASE_ENABLED` **plus** a separate route-export change,
  each reversible alone; enabling one requires the WP-8 load/deadline gates,
  explicit cost approval, and the rollback thresholds in
  `docs/runtime/wp8-flags-rollback.md`.
- No migration, no production configuration change in WP-8.
