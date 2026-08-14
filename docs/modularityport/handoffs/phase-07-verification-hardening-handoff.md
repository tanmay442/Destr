# Phase 07 Handoff — Verification Hardening

## 1. Summary (≤10 lines)

- Added 6 shared contract-assertion harnesses (RateLimiter, AnswerCache, IngestQueue, BlobStorage, EmbeddingService, Reranker) + 13 per-implementation contract test files in `packages/infrastructure/src/{auth,queue,storage,llm}/__tests__/contracts/` — 48 new tests, all green.
- Phase 3's existing `db/__tests__/contracts/` harness verified as the single suite source for VectorSearch/LexicalSearch/ChunkStore; re-ran its 40 pgvector contract tests green against the docker DB.
- CI: added a `Gate (test + typecheck + lint + arch)` step to `.github/workflows/ci.yml` running `pnpm gate` on PRs to master (additive; build already present).
- `.dependency-cruiser.cjs`: made `no-infrastructure-importing-next` load-bearing (dropped the dead `dependencyTypes: ['npm']` filter that never matched pnpm-resolved `next/*` imports) and added the sanctioned path-scoped exception for the four Clerk auth files. `pnpm arch` green (492 modules).
- Shim sweep: **zero removals** — every candidate (CHAT_TURN_USE_CASE flag, ContentParser Buffer aliases, ChunkRepository composite, env.ts legacy exports, db default export, DB.* bare exports) is kept with grep evidence; all documented as deferred/load-bearing.
- Risk register: E1, E2, R3, R4 retired with evidence; E3 (flag) kept/deferred; permanent guardrails re-verified (no new `process.env` reads; `from 'next/` only in the 2 of 4 sanctioned Clerk files that need it).
- Fixed the pre-existing flaky `db-integration.test.ts` ticket-aggregation test (Phase 03 flagged it for this phase): root cause is a timezone mismatch — `tickets.created_at` is a naive `timestamp` but the pg driver serializes `Date` params in local wall time; pinned `process.env.TZ = 'UTC'` for that suite. Test-only change.
- Master plan: **the original `docs/MODULARITY_IMPROVEMENT_PLAN.md` was never committed to this repo** (verified via `git log --all -- '*PLAN*'`); per the user's explicit instruction, no replacement master-plan document was authored this phase — see §4 and §11.

## 2. Status (date, HEAD hash, [ ] deliverables / gate / handoff complete)

- Date: 2026-08-14
- Branch: `modularity/phase-00-baseline` (carried deviation from Phases 00–06 — `master` lacks the phase chain; this branch contains all phases 00–06 + the master merge).
- HEAD before work: `b4d40c5 Merge branch 'master' into modularity/phase-00-baseline`
- Deliverables: matrix in handoff ✓ · harnesses + per-impl contract tests ✓ (`pnpm test` green) · CI gate step ✓ · dep-cruiser exception + comment ✓ (`pnpm arch` green) · shim decisions ✓ · risk register reconciled ✓ · master plan **skipped by user instruction** · handoff ✓
- Gate: PASS — test 1073 passed / 0 skipped (124 files), typecheck clean, lint clean, arch clean (492 modules), build succeeds.
- Handoff: complete.

## 3. Changes (file-by-file)

| File | New/Modified/Deleted | One-line description |
|---|---|---|
| `packages/infrastructure/src/auth/__tests__/contracts/rate-limiter-contract.ts` | New | Shared RateLimiter contract harness (`runRateLimiterContract(makeLimiter)`). |
| `packages/infrastructure/src/auth/__tests__/contracts/upstash-rate-limiter.contract.test.ts` | New | Runs the RateLimiter contract against `createUpstashRateLimiter` with a Lua-semantics Redis emulator. |
| `packages/infrastructure/src/auth/__tests__/contracts/lru-rate-limiter.contract.test.ts` | New | Runs the RateLimiter contract against `createLruRateLimiter`. |
| `packages/infrastructure/src/auth/__tests__/contracts/answer-cache-contract.ts` | New | Shared AnswerCache contract harness (`runAnswerCacheContract(makeCache)`). |
| `packages/infrastructure/src/auth/__tests__/contracts/upstash-answer-cache.contract.test.ts` | New | Runs the AnswerCache contract against `createUpstashAnswerCache` with a TTL-aware Redis emulator. |
| `packages/infrastructure/src/auth/__tests__/contracts/in-memory-answer-cache.contract.test.ts` | New | Runs the AnswerCache contract against `createInMemoryAnswerCache`. |
| `packages/infrastructure/src/queue/__tests__/contracts/ingest-queue-contract.ts` | New | Shared IngestQueue contract harness (`runIngestQueueContract(makeQueue, opts)`). |
| `packages/infrastructure/src/queue/__tests__/contracts/qstash-queue.contract.test.ts` | New | Runs the IngestQueue contract against `createQstashQueue` + asserts the publishJSON request shape. |
| `packages/infrastructure/src/queue/__tests__/contracts/sync-queue.contract.test.ts` | New | Runs the IngestQueue contract against `createSyncQueue` in both inline and no-op sub-modes. |
| `packages/infrastructure/src/storage/__tests__/contracts/blob-storage-contract.ts` | New | Shared BlobStorage contract harness (`runBlobStorageContract(makeStorage, opts)`). |
| `packages/infrastructure/src/storage/__tests__/contracts/blob-storage-fs.contract.test.ts` | New | Runs the BlobStorage contract against `createFilesystemBlobStorage` (temp dir). |
| `packages/infrastructure/src/storage/__tests__/contracts/blob-storage-s3-family.contract.test.ts` | New | Runs the BlobStorage contract against `createS3FamilyBlobStorage` with an in-memory AWS SDK emulator (covers r2 + s3; both delegate to the shared family impl). |
| `packages/infrastructure/src/llm/__tests__/contracts/embedding-service-contract.ts` | New | Shared EmbeddingService contract harness (`runEmbeddingServiceContract(makeEmbedder, opts)`). |
| `packages/infrastructure/src/llm/__tests__/contracts/openai-embedding-service.contract.test.ts` | New | Runs the EmbeddingService contract against `openAIEmbeddingService` (mocked `ai` + OpenAI SDK). |
| `packages/infrastructure/src/llm/__tests__/contracts/google-embedding-service.contract.test.ts` | New | Runs the EmbeddingService contract against `googleEmbeddingService`. |
| `packages/infrastructure/src/llm/__tests__/contracts/ollama-embedding-service.contract.test.ts` | New | Runs the EmbeddingService contract against `ollamaEmbeddingService` (incl. its VECTOR_DIM assertion). |
| `packages/infrastructure/src/llm/__tests__/contracts/reranker-contract.ts` | New | Shared Reranker contract harness (`runRerankerContract(makeReranker)`) — port discovered with ≥2 impls (local + cohere). |
| `packages/infrastructure/src/llm/__tests__/contracts/local-reranker.contract.test.ts` | New | Runs the Reranker contract against `localReranker` (mocked xenova). |
| `packages/infrastructure/src/llm/__tests__/contracts/cohere-reranker.contract.test.ts` | New | Runs the Reranker contract against `cohereReranker` (mocked fetch). |
| `.github/workflows/ci.yml` | Modified | Added "Gate (test + typecheck + lint + arch)" step running `pnpm gate` after the unit/integration tests step, before Build. |
| `.dependency-cruiser.cjs` | Modified | `no-infrastructure-importing-next`: dropped dead `dependencyTypes: ['npm']` filter, added commented `pathNot` exception for the four Clerk auth files. |
| `packages/infrastructure/src/db/__tests__/db-integration.test.ts` | Modified | Pinned `process.env.TZ = 'UTC'` — fixes the pre-existing flaky ticket-aggregation test (naive `timestamp` column vs local-wall-time Date params). |

Not touched: production code in `packages/*` (zero behavior change), `src/` app code, Clerk auth files, env var names/defaults, `drizzle/` migrations, production `dependencies`, `.env*` files.

## 4. Decisions & deviations (with rationale; esp. CI workflow create-vs-edit choice, shim removal choices)

1. **Master plan NOT authored — explicit user instruction.** The phase doc Step 7 requires updating `docs/MODULARITY_IMPROVEMENT_PLAN.md`, but (a) that file does not exist in the repo and never did (`git log --all -- '*PLAN*'` shows no such path ever committed; `docs/` is not gitignored, so this is a genuine gap, not an ignored file), and (b) the user explicitly directed: "skip the creation of any sort of master plan just continue forward." Deviation recorded here and in §11. The remaining phase-07 deliverables were all completed regardless.
2. **CI: edited the existing workflow (additive step), did not create a new job.** `.github/workflows/ci.yml` already existed with checkout/setup/install + individual typecheck/lint/arch/test/build steps. Per Step 3's "minimal and additive: don't refactor the existing workflow structure; add the gate as additional steps", I added one new step running `pnpm gate` after the "Unit & integration tests" step (so the DB is migrated when the gate's `pnpm test` runs) and before the existing Build step. The `pnpm build` requirement is already satisfied by the existing Build step (`pnpm exec next build` after `pnpm db:migrate` — the migrate-then-build composition of `pnpm build`).
3. **Dep-cruiser exception implemented as `pathNot` on the rule's `from`.** The phase doc's sketch suggested re-declaring the rule; the repo's actual syntax (dependency-cruiser v17) expresses a scoped exception via `from.pathNot`. I also **dropped the `dependencyTypes: ['npm']` filter**: verification showed pnpm resolves `next/*` imports as `npm-no-pkg`, so the old rule never fired (that's why `pnpm arch` was clean despite two Clerk files importing `next/server`). Without the filter, the rule now genuinely enforces "no `next/*` in infrastructure except the four sanctioned Clerk files" — a probe file importing `NextResponse` in `db/` correctly violated, and the sanctioned Clerk files passed. This makes the §8 guardrail load-bearing rather than decorative.
4. **Reranker added to the contract matrix** even though the phase doc's "expected matrix" didn't list it — Step 1 says "If you find a port with ≥2 impls missing from this list, add it." `Reranker` has two real implementations (`local-reranker.ts`, `cohere-reranker.ts`; `cosine` is a no-op `undefined` registration). Contract: one ranked result per input with original index and a 0..1 score.
5. **ChatModelProvider / graders / summarizer intentionally NOT contract-tested.** `getChatModel` returns an AI-SDK `LanguageModelV3` (vendor type, not a project port), and graders/summarizer are single implementations built on it. Cross-impl contract value is low and would only re-assert what per-provider tests already cover. Documented, not a gap.
6. **Shim removals: zero.** Every Step-5 candidate is load-bearing or non-existent:
   - `CHAT_TURN_USE_CASE` (E3): **kept** — Phase 06's handoff explicitly says the old path is retained and the flag must stay OFF until the real-model staging smoke is recorded (not available in this environment). Removing would violate C2/C9.
   - ContentParser `Buffer` aliases: **nothing to remove** — Phase 04 chose strict `Uint8Array` and never added aliases (grep confirms no parser aliases in `ports.ts`).
   - `ChunkRepository` composite, `config/env.ts` legacy exports, `db` module-level default export: **kept** (load-bearing for composition/compat; not marked temporary in any prior handoff).
   - `DB.ticketRepo`/`userRepo`/`auditRepo` bare exports: **kept** — `userRepo` is imported by `clerk-adapter.ts` (production), `ticketRepo`/`auditRepo` by db tests. Grep evidence in §9.
7. **db-integration flaky test: test-only TZ pin.** Phase 03's handoff diagnosed "pre-existing ticket data / scoped CTE limit 5000", but with an empty `tickets` table the failure persisted, and isolation repro showed `created_at >= :now` returning false for a ticket inserted at exactly `now`. Root cause: `tickets.created_at` is `timestamp` **without** timezone, while node-postgres serializes JS `Date` params in the **machine's local wall time** (this machine is UTC+5:30); Postgres then parses the offset string into the naive column comparison, shifting the boundary. CI (UTC) was never affected — hence "flaky". Fix pins `process.env.TZ = 'UTC'` at the top of the suite (test-only, matches CI semantics; `pnpm typecheck`/lint/arch unaffected). Verified: with the pin, `ge` becomes true and the suite passes; the earlier `expected +0 to be 1` failure disappears.
8. **Harness location follows the Phase 03 precedent** (`<concern>/__tests__/contracts/<port>-contract.ts` + `<impl>.contract.test.ts`), matching the phase doc's prescription and the existing `db/__tests__/contracts/` layout.
9. **Branch deviation carried from Phases 00–06:** worked on `modularity/phase-00-baseline` (all phases live here; `master` lacks phases 00–05). No out-of-scope files touched; no push.

## 5. Verification evidence (exact commands + outputs; contract-suite results; CI workflow diff; arch exception diff)

Docker DB up: `rag_agent-db-1 Up (healthy)`; `DATABASE_URL=postgres://postgres:ragagent_local_dev@localhost:5432/ragagent` in shell.

```text
pnpm test        → Test Files 124 passed (124); Tests 1073 passed (1073)  [0 skipped]
pnpm typecheck   → clean (no output)
pnpm lint        → clean (no output)
pnpm arch        → ✔ no dependency violations found (492 modules, 1247 dependencies cruised)
pnpm gate        → PASS (test → typecheck → lint → arch, in order)
pnpm build       → PASS — "✓ Compiled successfully in 23.4s" + full route table

New contract suites (all green):
pnpm exec vitest run packages/infrastructure/src/auth/__tests__/contracts/     → 4 files, 16 tests
pnpm exec vitest run packages/infrastructure/src/queue/__tests__/contracts/    → 2 files, 9 tests
pnpm exec vitest run packages/infrastructure/src/storage/__tests__/contracts/  → 2 files, 10 tests
pnpm exec vitest run packages/infrastructure/src/llm/__tests__/contracts/      → 5 files, 13 tests
  → Total: 13 files, 48 tests, 0 failures

Phase 3 contract suite re-run (single source of truth, unchanged):
pnpm exec vitest run packages/infrastructure/src/db/__tests__/contracts/ → 1 file, 40 tests passed
  (runs against the docker DB; skips only when DATABASE_URL is unreachable)

db-integration fix:
pnpm exec vitest run packages/infrastructure/src/db/__tests__/db-integration.test.ts → 2 passed (was 1 failed pre-fix)
  Pre-fix error: AssertionError: expected +0 to be 1 (from the afterFromNow range assertion)
  Root cause: naive `timestamp` column vs local-wall-time Date param serialization (TZ mismatch).

Dep-cruiser exception probe (rule now load-bearing):
  - probe `import { NextResponse } from 'next/server'` in db/ → violation on no-infrastructure-importing-next
  - clerk-adapter.ts (real sanctioned file) → no violation
  (see §4.3)
```

## 6. The verified port inventory (matrix: port → impls → contract harness path → test files)

| Port | Implementations (factory → module) | Harness | Impl contract test files |
|---|---|---|---|
| `RateLimiter` | `createUpstashRateLimiter` → `auth/upstash-rate-limiter.ts`; `createLruRateLimiter` → `auth/lru-rate-limiter.ts` | `auth/__tests__/contracts/rate-limiter-contract.ts` | `upstash-rate-limiter.contract.test.ts`, `lru-rate-limiter.contract.test.ts` |
| `AnswerCache` | `createUpstashAnswerCache` → `auth/upstash-answer-cache.ts`; `createInMemoryAnswerCache` → `auth/in-memory-answer-cache.ts` | `auth/__tests__/contracts/answer-cache-contract.ts` | `upstash-answer-cache.contract.test.ts`, `in-memory-answer-cache.contract.test.ts` |
| `IngestQueue` | `createQstashQueue` → `queue/qstash-queue.ts`; `createSyncQueue` → `queue/sync-queue.ts` (inline + no-op sub-modes) | `queue/__tests__/contracts/ingest-queue-contract.ts` | `qstash-queue.contract.test.ts`, `sync-queue.contract.test.ts` |
| `BlobStorage` | `createFilesystemBlobStorage` → `storage/blob-storage-fs.ts` (Node-only, no `signedUrl`); `createS3FamilyBlobStorage` → `storage/blob-storage-s3-family.ts` (shared by `createR2BlobStorage` + `createS3BlobStorage`; has `signedUrl`) | `storage/__tests__/contracts/blob-storage-contract.ts` | `blob-storage-fs.contract.test.ts`, `blob-storage-s3-family.contract.test.ts` |
| `EmbeddingService` | `openAIEmbeddingService` → `llm/openai-embedding-service.ts`; `googleEmbeddingService` → `llm/google-embedding-service-port.ts` (+`llm/google-embedding-service.ts` model factory); `ollamaEmbeddingService` → `llm/ollama-embedding-service.ts` | `llm/__tests__/contracts/embedding-service-contract.ts` | `openai-embedding-service.contract.test.ts`, `google-embedding-service.contract.test.ts`, `ollama-embedding-service.contract.test.ts` |
| `Reranker` (added: found ≥2 impls) | `localReranker` → `llm/local-reranker.ts`; `cohereReranker` → `llm/cohere-reranker.ts` (`cosine` = sanctioned no-op) | `llm/__tests__/contracts/reranker-contract.ts` | `local-reranker.contract.test.ts`, `cohere-reranker.contract.test.ts` |
| `VectorSearch` / `LexicalSearch` / `ChunkStore` (Phase 3) | pgvector adapters → `db/{vector-search,lexical-search,chunk-store}.ts` (+ `createChunkRepositoryCompat` shim) — single impl today | `db/__tests__/contracts/chunk-contracts.ts` (existing, Phase 03) | `db/__tests__/contracts/pgvector-contracts.test.ts` (existing, 40 tests, re-run green) |

Excluded by design: `AuthAdapter` (single Clerk impl, vendor-locked); `ChatModelProvider`/graders/summarizer (AI-SDK vendor type or single impl); `ContentParser`/`MarkdownParser`/`PdfParser`/`TextSplitter` (single impls); repo ports (`DocumentRepository`, `TicketRepository`, …) (single pg adapter each).

**Behaviors not asserted generically (port-specific quirks, documented):**
- BlobStorage content-type: the port has no read path for content-type; FS ignores it and S3-family forwards it to the client — asserted only at the S3-family boundary (impl test), not in the generic harness.
- BlobStorage `signedUrl`: FS has none → gated behind `opts.supportsSignedUrl`.
- IngestQueue QStash request shape (url/body/retries/DLQ) is remote-specific → asserted in the qstash impl test; the generic harness only asserts enqueue success + `isNoOp()` + inline delivery.
- AnswerCache TTL: backend expiry is enforced lazily (Upstash TTL vs in-memory sweep) → the harness advances time past the TTL and asserts null with a documented tolerance note.
- EmbeddingService order preservation is asserted via an injected `vectorFor` mapping shared between the impl's `ai` mock and the harness.

## 7. Risk register reconciliation (E1/E2/E3/R3/R4 + guardrails: retired vs deferred, with evidence)

| ID | Status | Evidence |
|---|---|---|
| E1 (dotenv relocation, Phase 1) | **Retired** | Phase 01 handoff proves entry-point parity; `loadDotEnv()` present at all inventory-B entry points (`scripts/{migrate,setup-test-db,teardown-test-db,backfill-blobs,seed-docs,eval/run}.ts`, `drizzle.config.ts`, `packages/cli/src/index.ts`); `db/pool.ts` has no dotenv import. |
| E2 (VECTOR_DIM throw timing, Phase 1) | **Retired** | Fail-fast preserved at client creation — `createDbClient({ env })` throws on invalid `EMBEDDING_DIMENSION`; `db/__tests__/client.test.ts` (3 tests) exists and is green; `EMBEDDING_DIMENSION=invalid` fail-fast message unchanged (Phase 01 §5). |
| E3 (CHAT_TURN_USE_CASE flag, Phase 6) | **Deferred (kept)** | Phase 06 handoff: old path retained, flag OFF by default, real-model staging smoke not available; route.ts:488 still gates on `process.env.CHAT_TURN_USE_CASE === '1'`. Removing would change behavior (C2/C9). Follow-up: remove only after real-model smoke + old-path deletion (Phase 06 Commit 2 criteria). |
| R3 (cache-key drift, Phase 6) | **Retired** | `src/app/api/chat/cache-key.golden.test.ts` (12 fixtures) in suite and green (part of `pnpm test` 1073). |
| R4 (stream-protocol drift, Phase 6) | **Retired** | `src/app/api/chat/chat-turn.parity.test.ts` (16 cases) in suite and green. |
| Permanent guardrail: no-new-`process.env` in `packages/` | **Verified** | `grep -rn "process\.env" packages/ --include="*.ts"` non-test: **85 lines** — all pre-existing sanctioned sites (auth vendor-locked, llm/queue/storage factory reads, cli commands, `config/env.ts:37` `defaultProcessEnv` single infra site). This phase added **zero** new `process.env` reads (contract tests stub env in test files only). Note: the phase doc §8's "zero except defaultProcessEnv" literal target is not achievable per Phase 01/02 handoffs — vendor-locked auth and provider factory reads are permanent by design; the enforceable guardrail is "no NEW reads", which holds. |
| Permanent guardrail: no-new-`next/*` in `packages/infrastructure` | **Verified + now rule-enforced** | `grep -rn "from 'next" packages/infrastructure/` → only `auth/auth-factory.ts` and `auth/clerk-adapter.ts` (both within the 4 sanctioned Clerk files; `clerk-session.ts`/`clerk-shared.ts` import no next). `no-infrastructure-importing-next` now actually fires for non-sanctioned files (probe-verified). |

## 8. CI changes (file, steps added, expected gate behavior)

- File: `.github/workflows/ci.yml` (existing PR-to-master workflow, edited additively).
- Added step: `Gate (test + typecheck + lint + arch)` → `pnpm gate`, placed after "Unit & integration tests" and before "Build", with the same LLM secrets env as the test step.
- Expected behavior: every PR to master now runs the exact `pnpm gate` aggregate (test → typecheck → lint → arch) in addition to the existing individual fast-feedback steps, then the existing Build step (`pnpm exec next build` after `pnpm db:migrate`, equivalent to `pnpm build`'s migrate-then-build). The docker `db` service is already part of the job, so the gate's `pnpm test` runs the DB-backed contract suites for real.
- No new tooling added (C4); no env var changes (C3).

## 9. Shim retirement summary (removed vs deferred, with reason + grep evidence)

| Shim | Phase | Status | Reason / evidence |
|---|---|---|---|
| `CHAT_TURN_USE_CASE` flag | 06 | **Deferred (kept)** | Old path retained per Phase 06 handoff; real-model smoke unavailable; flag still at route.ts:488. |
| ContentParser `Buffer` aliases | 04 | **Nothing to remove** | Phase 04 chose strict `Uint8Array`; `grep -n "Buffer" packages/domain/src/ports.ts` shows no parser alias (only `BlobStorage`/`PdfParser`/`Hasher` Buffers, out of scope). |
| `ChunkRepository` composite | 03 | **Kept** | Load-bearing: `src/composition.ts` still calls `Db.createChunkRepo(dbClient)`; contract suite exercises both split ports and the composite shim. |
| `config/env.ts` legacy named exports | 01 | **Kept** | Load-bearing compat surface; byte-identical values (Phase 01 §6). |
| `db` module-level default export | 01 | **Kept** | Load-bearing compat; per-process singleton semantics enforced in Phase 05. |
| `DB.ticketRepo`/`userRepo`/`auditRepo` bare exports | 05 | **Kept** | Non-composition consumers exist: `packages/infrastructure/src/auth/clerk-adapter.ts:12` imports `userRepo`; `db/__tests__/audit-backfill.test.ts` and `db-integration.test.ts` import `auditRepo`/`ticketRepo`. |

## 10. Master plan update (link + summary of what changed)

**Not performed — user explicitly instructed to skip master-plan creation** ("skip the creation of any sort of master plan just continue forward"). Additionally, the original `docs/MODULARITY_IMPROVEMENT_PLAN.md` never existed in this repo's history. See §4.1 and §11 for the full gap record.

## 11. Remaining debt / known issues / follow-ups (anything that didn't fit the program)

1. **Master plan document absent (pre-existing gap, escalated):** the plan that every phase references (`docs/MODULARITY_IMPROVEMENT_PLAN.md`, its §9 risk register and §10 sanctioned-exception sections) was never committed to the repo. The orchestrator should either restore it from wherever it originally lived or accept the handoffs as the de-facto plan record.
2. **E3 flag retirement blocked on real-model smoke:** `CHAT_TURN_USE_CASE` stays until Phase 06's Commit-2 criteria (real-model staging smoke + old-path deletion) are completed. The R3/R4 parity suites are green and in CI, so the only blocker is the external smoke test.
3. **`process.env` guardrail is "no NEW reads", not literal zero:** 85 pre-existing non-test reads in `packages/` remain by design (vendor-locked Clerk, provider factories). A future program could centralize the llm/queue/storage factory reads via the config port, but that is a deliberate behavior-adjacent refactor, out of scope here.
4. **QStash contract uses a mocked `Client`, not a fake HTTP layer:** `createQstashQueue` constructs its own `Client` internally, so the contract test asserts the `publishJSON` argument shape against a mocked client rather than intercepting HTTP. If a future refactor injects the client, the harness could be tightened (documented in §6).
5. **`db-integration.test.ts` TZ pin:** a pragmatic test-only fix; the deeper issue (naive `timestamp` column vs local-wall-time Date params) is a latent production footgun for any non-UTC deployment passing JS `Date` ranges into `getTicketResponseTimes`. Worth a follow-up to normalize the column or serialize params in UTC.
6. **Contract coverage boundaries (by design):** AuthAdapter (vendor-locked), chat-model provider registry, single-impl ports, and repo ports are not cross-impl contract-tested; rationale in §6.
7. Pre-existing (unchanged, from earlier phases): `master` behind this branch; `docs/modularityport/` gitignored (force-add handoffs); `pnpm seed` ENOENT without `documents/` fixtures; `.env.test` sanitized placeholder when Neon creds absent.

## 12. Re-verified prior phases (list of phases whose metrics you re-ran + result)

All re-verified green via the full gate on this branch (HEAD `b4d40c5` + phase-07 changes):

| Phase | Metric re-run | Result |
|---|---|---|
| 00 (gates) | `pnpm gate`, `pnpm build` | PASS |
| 01 (config injection) | `pnpm test` (client.test.ts E2 suite), typecheck, arch | PASS |
| 02 (provider registry) | `pnpm test`, switch-removal greps (spot-checked), arch | PASS |
| 03 (port split) | `db/__tests__/contracts/pgvector-contracts.test.ts` → 40 tests | PASS |
| 04 (parser cleanup) | `pnpm test` incl. `unpdf-parser.test.ts`, typecheck | PASS |
| 05 (composition root) | `packages/infrastructure/src/core.test.ts` (singleton suite), `pnpm test` | PASS |
| 06 (chat turn) | `chat-turn.parity.test.ts` (R4), `cache-key.golden.test.ts` (R3), route/request-schema tests | PASS (all within `pnpm test` 1073) |

Count of phases re-verified: **7 of 7**.

## 13. Effort notes (S/M/L — closing phase; reflect honestly on time + surprises)

- Size: M. The bulk was authoring 19 contract files (6 harnesses + 13 impl tests) and the gate run (~80s test / ~25s build each).
- Surprise 1: **the `no-infrastructure-importing-next` rule was already dead** — pnpm resolves `next/*` as `npm-no-pkg`, which the `dependencyTypes: ['npm']` filter never matched. That's why Phase 00 reported "no violation exists". Dropping the filter made the §10 exception real, and the probe proved enforcement.
- Surprise 2: **the "flaky" db-integration failure was a timezone bug, not stale data.** Phase 03's diagnosis (pre-existing ticket data / `limit 5000` CTE) did not reproduce with an empty `tickets` table; isolation showed `created_at >= :now` failing for a ticket inserted at `now` on this UTC+5:30 machine. Test-only TZ pin fixed it and matches CI semantics.
- Surprise 3: **the master plan never existed in git** — every phase references it, but no commit ever added it; combined with the user's explicit skip instruction, §10/§11 record the gap rather than inventing a plan document.
