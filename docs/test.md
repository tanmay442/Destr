# Test Suite & Verification Metrics

This project uses **Vitest** for unit, integration, and contract testing, **TypeScript** (`tsc`) for static type checking, **ESLint** for code style, and **dependency-cruiser** for Clean Architecture layer validation.

---

## Test Suite Metrics

| Metric | Count / Status | Notes |
|---|---|---|
| **Total Test Files** | **142 files** | Full local run against Docker Postgres: all passed, no skips |
| **Total Test Cases** | **1,418 tests** | Full local run against Docker Postgres: all passed, no skips |
| **Architecture Modules** | **536 modules** | 1,400 dependencies checked with **0 violations** |
| **Suite Run Duration** | **~26s** | Full suite execution including transform, setup, import, and runner |
| **Gate Script** | `pnpm gate` | Runs `Vitest` + `tsc --noEmit` + `eslint` + `dependency-cruiser` |

---

## Quality Gate Commands

All pull requests and local changes are verified via the same four gates — Vitest, TypeScript (`tsc --noEmit`), ESLint, and dependency-cruiser architecture rules — individually or via single-command wrappers:

```bash
# Run the test suite only (equivalent to `pnpm vitest run`):
pnpm test

# The four gates individually:
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run

# Run full quality gate: Vitest + TypeScript + ESLint + Dependency Architecture
pnpm gate

# Run full gate + Next.js production build verification:
pnpm gate:build

# Run migrations before a production build when needed:
pnpm build:with-db

# Run interactive Vitest UI:
pnpm test:ui

# Run CI-style test suite (provisions and teardowns test DB):
pnpm test:ci

# Run against an explicitly supplied existing DATABASE_URL when Neon branch
# credentials are unavailable (intentional opt-in):
pnpm setup-test-db --use-existing
```

---

## Test Organization by Architecture Layer

```
test-distribution/
├── packages/domain/         # Pure schema, error hierarchy, sanitization tests
├── packages/application/    # Pure use-case tests (chat-turn, ingest, search, tickets, analytics)
├── packages/infrastructure/ # Database repos, LLM services, and shared contract suites
├── packages/cli/            # CLI command tests (init, setup, seed, upload, purge-chat-events, purge-chat-history, db-migrate)
└── src/                     # API route handlers, UI components, parity suites, middleware gating
```

---

## Port Contract Testing Matrix (`packages/infrastructure/src/`)

Multi-implementation ports are validated through **shared contract-assertion harnesses** to guarantee identical behavior across all implementations:

| Port Interface | Implementations Tested | Contract Harness Path | Contract Test Files |
|---|---|---|---|
| `RateLimiter` | `UpstashRateLimiter`, `LruRateLimiter` | `auth/__tests__/contracts/rate-limiter-contract.ts` | `upstash-rate-limiter.contract.test.ts`, `lru-rate-limiter.contract.test.ts` |
| `AnswerCache` | `UpstashAnswerCache`, `InMemoryAnswerCache` | `auth/__tests__/contracts/answer-cache-contract.ts` | `upstash-answer-cache.contract.test.ts`, `in-memory-answer-cache.contract.test.ts` |
| `IngestQueue` | `QstashQueue`, `SyncQueue` (inline & no-op) | `queue/__tests__/contracts/ingest-queue-contract.ts` | `qstash-queue.contract.test.ts`, `sync-queue.contract.test.ts` |
| `BlobStorage` | `FilesystemBlobStorage`, `S3FamilyBlobStorage` (R2 & S3) | `storage/__tests__/contracts/blob-storage-contract.ts` | `blob-storage-fs.contract.test.ts`, `blob-storage-s3-family.contract.test.ts` |
| `EmbeddingService` | `OpenAIEmbeddingService`, `GoogleEmbeddingService`, `OllamaEmbeddingService` | `llm/__tests__/contracts/embedding-service-contract.ts` | `openai-embedding-service.contract.test.ts`, `google-embedding-service.contract.test.ts`, `ollama-embedding-service.contract.test.ts` |
| `Reranker` | `LocalReranker`, `CohereReranker` | `llm/__tests__/contracts/reranker-contract.ts` | `local-reranker.contract.test.ts`, `cohere-reranker.contract.test.ts` |
| `VectorSearch` / `LexicalSearch` / `ChunkStore` | PgVector Adapters | `db/__tests__/contracts/chunk-contracts.ts` | `pgvector-contracts.test.ts` |

---

## Core & Parity Test Suites

- **Composition Singleton (`packages/infrastructure/src/core.test.ts`)**:
  Validates `buildCoreDeps()` singleton semantics, default environment memoization, and custom environment isolation.

- **Chat Turn Use-Case Parity (`src/app/api/chat/chat-turn.parity.test.ts`)**:
  Validates 100% side-by-side behavioral parity between legacy inline chat routing and the decoupled `@app/application/chat` turn use-case, including a persistence case asserting both paths save identical chat history.

- **Answer Cache Golden Key (`src/app/api/chat/cache-key.golden.test.ts`)**:
  Pins cache key generation stability across text normalization, model changes, and configuration fingerprints.

---

## Application Use-Case & Route Test Catalog

- **Chat Route & Tools (`src/app/api/chat/route.test.ts`)**:
  Auth checks (401/429), `searchDocumentation` and `createKnowledgeTicket` tool execution, citation emission, duplicate-result filtering across repeated searches, first-turn prefetching, and answer cache hit/miss semantics.
- **Grounding Evidence (`packages/application/src/chat/__tests__/grounding-evidence.test.ts`)**:
  Per-turn chunk identity deduplication, fallback identity for incomplete test data, bounded model/grader context, and citation aggregation.
- **Agentic Retrieval (`packages/application/src/rag/agentic-search.test.ts`)**:
  Query rewrite -> hybrid retrieve + rerank pass loop, step budget enforcement, out-of-domain detection, one fresh-rewrite retry when a pass retrieves nothing (`agenticMaxRetries`) before the empty/out-of-domain wall, empty-query short-circuit, similarity/hybrid option forwarding, and the query-rewrite toggle (retrieved chunks are passed through unfiltered to the reranker-ordered generator).
- **True Quality Checks (PR #60 suites)**:
  - **LLM Judges & Aux Models (`packages/infrastructure/src/llm/judge.test.ts`, `aux.test.ts`)**: relevance/faithfulness judging with 10s timeout -> null, retry with plain-text parse recovery, untrusted-prompt fencing; `aux.test.ts` also covers the query rewriter (echo-on-failure, turn-budget exhaustion) and the hallucination checker's fail-open contract (throws rather than flipping to grounded on malformed output or persistent outage), plus the `getAuxModels` selector and `createAuxModels` dependency-injection behavior.
  - **Cache gating (`packages/application/src/chat/__tests__/should-cache.test.ts`)**: guardrail-blocked, empty-wall, ticket-creating, and hallucination-timeout turns are excluded from the answer cache.
  - **Event meta (`packages/application/src/chat/__tests__/build-event-meta.test.ts`)**: `rewritten` / `fallbackReason` (turn deadline only) / `isEmpty` / `resultState` / `judgeScores` quality fields on `chat_events.meta`.
  - **Quality review queue (`packages/infrastructure/src/db/__tests__/quality-reviews-repo.test.ts`)**: verdicts (`good`/`bad`/`docs_missing`), one review per turn per reviewer, sampled-turn listing.
- **Admin Document & Ingestion (`packages/application/src/admin/__tests__/`)**:
  Soft delete, restoration, re-ingest pagination, pre-chunked Markdown parsing, CCH header injection.
- **Ingest Status Poller (`src/app/api/admin/documents/status/route.test.ts`)**:
  Auth gating and single aggregate pending-count query (`countPendingIngest`), replacing the previous full-table walk.
- **Ticket Management (`packages/application/src/admin/__tests__/tickets.test.ts`)**:
  Ticket state machine transitions (`VALID_TRANSITIONS`), notes append, response time calculation, audit trail generation, and admin-only assignment enforcement (unknown/non-admin assignees rejected server-side).
- **User Role Management (`packages/application/src/auth/__tests__/users.test.ts`)**:
  Role promotion/demotion, Clerk metadata sync, admin count lock assertions.
- **Sanitization (`packages/domain/src/sanitize-text.test.ts`, `src/lib/__tests__/sanitize.test.ts`)**:
  Reasoning trace stripping (`<think>`, `<thought>`, `<antThinking>`), control character removal.
- **Middleware & Auth Gating (`src/proxy.test.ts`)**:
  Clerk middleware route protection (public, signed-in, admin-only routes, cron secret bypass).
- **Chat History Persistence** (feature suites):
  - **Use cases (`packages/application/src/chat/__tests__/history.test.ts`)**: ownership passthrough and pagination defaults/caps, conversation/message cap conflicts, title sanitization + auto-title, stored-message whitelisting (`toStoredMessage`), byte-cap truncation, and audit emission on delete.
  - **Repository (`packages/infrastructure/src/db/__tests__/chat-history-repo.test.ts`)**: transactional turn append with lazy conversation upsert, idempotent re-fire with correct `message_count` delta, retry replacement, retention purge, and whole-user purge. Live-DB gated — skips unless `DATABASE_URL` is set and reachable.
  - **Conversations API (`src/app/api/chat/conversations/route.test.ts`, `conversations/[id]/route.test.ts`)**: auth gating, same-origin enforcement on mutations, ownership 404s, validation 400s for list/resume/rename/delete.
  - **CLI (`packages/cli/src/__tests__/purge-chat-history.test.ts`)**: `--days`/`--dry-run`/`--yes`/`--allow-sub-day` parsing, mandatory `--days` while the admin window is Off, dry-run counts.
  - **Retention config (`packages/domain/src/app-config.test.ts`)**: `chatHistoryRetentionDays` default 120; only 0 (Off) / 30 / 120 / 365 accepted.
  - **GDPR erasure (`.../users/[clerkId]/gdpr/route.test.ts`)**: saved chats purged in both `purge` and `anonymize` modes.
  - **Components (`src/components/app/AppSidebar.test.tsx`, `src/components/ChatConversationLoader.test.tsx`, `src/components/ChatInterface.test.tsx`)**: sidebar list fetch/active highlight/delete-confirm flows, conversation id sent with every message, resume rebuilds citation parts from stored metadata, composer blocks at the per-conversation message cap, retry mints a fresh turn id.

---

## Environment Sensitivity & Test Isolation

Some tests assert missing environment variable guards (e.g., Upstash credentials absent). These tests use explicit `vi.stubEnv` isolates to remain green in any environment:

```typescript
// Explicitly stub variables to empty strings when testing missing credential paths
vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
```

When writing new tests that assert "absent credential" errors, always stub the variable explicitly rather than relying on ambient shell environment state.

### Database-Backed Tests (local setup)

DB-backed suites (e.g. `packages/infrastructure/src/db/__tests__/chat-history-repo.test.ts`, the db integration/repositories tests) probe `DATABASE_URL` with a `SELECT 1` and **skip** when it is unset or unreachable — they never fail on a machine without a database. To run them locally:

```bash
pnpm dev:db                 # docker compose up -d db (pgvector on 127.0.0.1:5432)
export DATABASE_URL=postgres://postgres:ragagent_local_dev@127.0.0.1:5432/ragagent
MIGRATION_DATABASE_URL=$DATABASE_URL pnpm db:migrate   # apply drizzle/ migrations
DATABASE_URL=$DATABASE_URL pnpm test  # DB-gated suites now execute instead of skipping
```

Vitest loads `.env.test` when present, and its values take precedence over inherited shell variables so the branch created by `test:ci` is tested. Remove `.env.test` to use the local shell URL above. The password matches `.env.example` / `docker-compose.yml`. Migration tooling prefers `MIGRATION_DATABASE_URL` and falls back to `DATABASE_URL`; against a fresh local volume either works, since the compose user owns the database.

`setup-test-db` refuses to use an ambient `DATABASE_URL` when
`NEON_PROJECT_ID`/`NEON_API_KEY` are missing unless `--use-existing` is passed.
The blob backfill is also guarded: it defaults to a dry run and requires
`--confirm`; use `--allow-non-prod` only for an intentional non-production run.

---

## Continuous Integration (CI)

CI executes the complete test suite and quality gate on every Pull Request to `master`:

1. **Service Container**: Provisions a `pgvector/pgvector:pg16` Docker container.
2. **Migrations**: Applies Drizzle database migrations (`pnpm db:migrate`).
3. **Quality Gate Steps**: Runs the `pnpm gate` checks as individual steps — `tsc --noEmit` -> `eslint` -> `dependency-cruiser` -> `pnpm test`.
4. **Build Verification**: Executes `pnpm build` (`next build` without migrations).
