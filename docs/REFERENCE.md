# Destr — Technical Reference Manual

Technical reference for the Destr RAG knowledge agent: tech stack, architecture, authentication, admin operations, database schema, and operational subsystems.

---

## 1. Technology Stack

| Component | Technology | Description |
|---|---|---|
| **Framework** | Next.js 16 (App Router) | React 19, Turbopack, Server Actions |
| **AI / RAG** | Vercel AI SDK v6 | Tool-calling, streaming, grounded citations |
| **Database** | Neon Postgres + pgvector | HNSW vector search + PostgreSQL full-text search, fused via Reciprocal Rank Fusion |
| **ORM** | Drizzle ORM | Type-safe schema definition and migrations |
| **Auth** | Clerk (`@clerk/nextjs` v7) | Middleware-gated sessions & RBAC roles |
| **Testing** | Vitest & Testing Library | Unit, integration, and port contract suites |
| **Styling** | Tailwind CSS v4 | Achromatic greyscale (neutral ramp) design |

---

## 2. Modular Clean Architecture Deep Dive

The business logic is organized into a 4-layer monorepo inside `packages/`:

```
rag_agent/
├── packages/
│   ├── domain/         # @app/domain — Pure types, Zod schemas, Result<T,E>, port interfaces
│   ├── application/    # @app/application — Use-cases returning Result<T, DomainError>
│   ├── infrastructure/ # @app/infrastructure — Drizzle repos, AI SDK adapters, PDF parsers
│   └── cli/            # @app/cli — `rag-agent` CLI (init, setup, seed, upload, purge-chat-events, purge-chat-history, db-migrate)
└── src/                # Next.js App Router shell, UI components, and composition root
```

### Modularity Highlights & Port Design
- **Environment & Config Abstraction (`@app/domain`, `@app/infrastructure`)**: `EnvSource` and `RuntimeConfig` ports decouple environment loading from ambient `process.env`, enabling deterministic configuration injection and testing.
- **Provider Registry & Factory Injection (`packages/infrastructure/src/registry.ts` + `llm/`)**: Multi-provider LLM, embedding, and reranker implementations (Google, OpenAI, Ollama, Cohere, Local Xenova cross-encoder) are selected dynamically via factory functions.
- **Interface-Segregated Chunk Ports (`packages/domain/src/ports.ts`)**: `VectorSearch`, `LexicalSearch`, and `ChunkStore` are segregated to allow independent substitution of storage and search mechanisms. The original composite `ChunkRepository` is retained for existing consumers.
- **Runtime-Neutral Content Parsing**: `ContentParser` accepts `Uint8Array` rather than Node `Buffer`, improving portability across serverless/edge runtimes (sibling ports — `BlobStorage`, `PdfParser`, `Hasher` — still use `Buffer`).
- **Centralized Composition Root (`packages/infrastructure/src/core.ts` & `src/composition.ts`)**: `buildCoreDeps()` memoizes shared DB pools and timers on the default environment while allowing isolated instantiations for testing.
- **Application Use-Cases (`@app/application`)**: Document ingestion, tickets, and analytics are pure functions returning `Result<T, DomainError>`, decoupled from Next.js request/response APIs. Exception: `chatTurn` returns a `ChatTurnResult` union and consumes the AI SDK directly (`ai`, `@ai-sdk/provider`), see layer note below.
- **Port Contract Testing Matrix (`packages/**/__tests__/contracts/`)**: Shared contract suites guarantee all multi-implementation ports (`RateLimiter`, `AnswerCache`, `IngestQueue`, `BlobStorage`, `EmbeddingService`, `Reranker`) satisfy identical functional contracts.

### Architecture Layer Rules (Enforced by `pnpm arch`)

| Layer | May Import | May NOT Import |
|---|---|---|
| **`domain`** | `zod` | `application`, `infrastructure`, `cli`, `src/`, `drizzle-orm`, `@ai-sdk/*`, `next`, Node built-ins |
| **`application`** | `domain` | `infrastructure`, `src/app`, `src/components`, `drizzle-orm`, `next` |
| **`infrastructure`** | `domain`, `drizzle-orm`, `@ai-sdk/*`, `clerk`, `unpdf`, `pg` | `application`, `src/app`, `src/components`, `next` (scoped Clerk request exception only) |
| **`src/`** | `application`, `domain`, `src/lib/*`, `@ai-sdk/react`, `next`, `@clerk/nextjs` | `drizzle-orm`, `pg`, `unpdf`, `@app/infrastructure` (except composition root) |
| **`cli`** | `application`, `infrastructure`, `dotenv` | `src/app`, `src/components` |

Note: `@app/application` declares `ai` / `@ai-sdk/provider` dependencies for `chat-turn.ts`; dependency-cruiser does not resolve npm-scoped imports, so that edge is not machine-enforced.

---

## 3. Identity, Auth & Role-Based Access Control (RBAC)

### Provider & Architecture
- **Provider**: Clerk (`@clerk/nextjs` v7); hosted `<SignIn />` / `<SignUp />` components at `/sign-in` and `/sign-up`.
- **Role Model**: Every user carries a role of `admin` or `user`. The local `users` table (**`clerk_user_id` PK**, `email` unique) is authoritative. `resolveRole` order: (1) local DB row, (2) verified admin email, (3) `session.metadata.role` claim — JWT claims are a **fallback only** when no DB row exists. DB-over-JWT is test-covered (e.g. a demoted user is rejected despite admin claims).
- **Role Resolution Cache**: a 30-second in-memory TTL cache backs middleware role checks (`invalidateRoleCache()` on role changes), so demotions apply within ~30s. This cache — not JWT claims — is what makes middleware gating fast (no Clerk Backend SDK round-trip).
- **Admin Auto-Promotion**: a comma-separated list in `ADMIN_EMAILS` promotes users to `admin` on the first server-side session read (`getAppSession` upsert), once Clerk marks their email verified; the role is written back to Clerk `publicMetadata`. Verified admin-email holders can access `/admin` before a DB row exists via the session token's `email` / `email_verified` claims.
- **Clerk JWT Session Template** (for the claim fallback): Clerk Dashboard → Sessions → Customize session token → `{"metadata": "{{user.public_metadata}}"}` projects `publicMetadata.role` into `session.metadata.role`.

### Route Gating & Protection Matrix
- **`src/proxy.ts`** executes `clerkMiddleware`:
  - `/chat(.*)`, `/admin(.*)`, `/api/chat(.*)`, `/api/admin(.*)` require an active authenticated session.
  - `/admin(.*)` and `/api/admin(.*)` additionally require `role === 'admin'` (DB-first, claims fallback for pre-DB-row admins).
  - Non-admin page visits redirect to `/chat`; non-admin API calls return `HTTP 403`; other unmatched `/api/*` routes return `401`.
  - Exemptions: `/api/admin/analytics/rollup` and `/api/admin/queue/sweep` accept a valid `Authorization: Bearer <CRON_SECRET>`; `/api/admin/ingest-worker(.*)` is QStash-signed and excluded from middleware auth.
- **Defense in Depth**: the admin layout invokes `requireAdmin()`, and admin API routes re-check `requireAdminRoute`, independent of middleware.
- **Server Action Gating**: every admin server action in `src/app/(app)/admin/actions.ts` invokes `requireAdmin()` first.

---

## 4. Admin Console Subsystems

- **Pagination**: all list tables (documents, users, tickets, audit) use server-side pagination at 30 rows/page with prev/next controls; out-of-range pages redirect to the last valid page.

### Overview (`/admin`)
- Metric cards: documents, chunks, tickets, open tickets, users; latest 10 audit events (per-request render, not a push stream).

### Document Management (`/admin/documents`)
- **Upload**: PDF-only dialog (magic-byte validated server-side). Markdown ingestion exists only via the chunked-upload API (`/api/admin/upload-chunked`, no UI). Uploads ≥4 MB are processed async through the QStash queue + `/api/admin/ingest-worker`, surfaced as queued/ingesting statuses.
- **Inline PDF Preview**: secure iframe backed by `/api/admin/documents/[id]/blob`.
- **Soft Deletion**: `deleted_at` tombstone with a 7-day restore window; re-uploading a file restores its soft-deleted row automatically. There is no automatic purge — "hard delete" is a manual, type-the-name-confirmed row action available anytime.
- **Row actions**: Recount chunks (refreshes live-computed counts — nothing is persisted), Download, Soft/Hard delete.

### Support Ticket Intelligence (`/admin/tickets`)
- **Statuses**: `created`, `in_progress`, `closed` (no `resolved`). Transitions: `created → in_progress|closed`, `in_progress → closed|created`, `closed → ∅`.
- **Ticket Drawer**: deep-linked `?ticket=<id>` mounts details, issue, assignees, notes thread, status controls.
- **Admin-Only Assignment**: enforced server-side in the `updateTicket` use case; dropdowns list only admin-role users.
- **Identifiers**: collision-resistant `TKT-<8-hex>` from `randomUUID` with retry on collision.
- **Filters**: assignee and text search beyond status.

### Analytics & Telemetry Engine (`/admin/analytics`)
Four tabs from `chat_events` + materialized `chat_daily_stats` (12-week trend window is a consumer default):
1. **Statistics**: turns, hallucination blocks, out-of-domain refusals, self-serve rate; 12-week SVG `LineChart` with 5% hallucination threshold; token-cost estimate; 7-day `ActivityBars`.
2. **Performance**: cache-hit rate + trend; p50/p95 latency (`retrieve`, `generate`, `total`); Agentic vs Vector avg tokens/query; top-5 cache-buster queries; agentic retry rate.
3. **Feedback**: 👍/👎 distribution, per-document sentiment, thumbs-down hotspots, document utility rankings, zero-hit documents.
4. **Tickets**: weekly ticket volume, turns-to-ticket distribution, first-response/resolution medians from `audit_events` histories.

### Comprehensive Audit Log (`/admin/audit`)
- Consolidated over `audit_events`; filterable by `kind` (`document`/`ticket`/`user`/`settings`), `action`, `actor`, `documentId`/`ticketId`, and date range.
- **Settings Diffs & One-Click Revert**: settings updates record `details.changes = [{key, old, new}]`; Revert re-PUTs through the same audited route.
- **Dead-Letter (`audit_dead_letter`)**: audit writes are non-blocking; transient failures persist payload + error for manual inspection (no replay UI exists).

### Runtime Configuration & Precedence (`/admin/settings`)
Driven by the Zod introspection descriptor at `GET /api/admin/settings/schema`. Admin edits apply with optimistic concurrency (`expectedVersion`, 409 on conflict, re-apply dialog); `PUT /api/admin/settings` is rate-limited (1/5s). Precedence (highest wins):
1. **Environment Lock (`APP_SETTINGS_LOCK`)**: comma-separated dot-paths locked read-only.
2. **Database Overrides**: `app_settings` singleton row (`id = 1`).
3. **Application Config Defaults**: `config/app.config.ts`.
4. **Domain Schema Defaults**: `appConfigSchema` in `@app/domain`.

---

## 5. Database Schema Reference

PostgreSQL with `pgvector`, managed via Drizzle ORM. Schema source: `packages/infrastructure/src/db/schema.ts` (vector bits in `schema-vector.ts`).

| Table | Description | Key Columns |
|---|---|---|
| `documents` | Ingested PDF sources | `id`, `file_name`, `file_hash`, `uploaded_by`, `uploaded_at`, `blob`/`storage_key`, `ingest_status`, `deleted_at` |
| `chunks` | Text chunks with embeddings + FTS vector | `id`, `document_id`, `chunk_index`, `kind` (parent/child/summary), `parent_chunk_id`, `page`, `title`, `content`, `embedding`, `content_hash`, `tsv` |
| `tickets` | Support escalation tickets | serial `id` + unique `ticket_id` (`TKT-*`), `user_id`, `name`, `email`, `issue`, `status`, `assigned_to`, `notes`, `created_at` |
| `users` | Local mirror of Clerk identities + RBAC | `clerk_user_id` (PK), `email` (unique), `name`, `image_url`, `role`, `last_seen_at`, `created_at` |
| `app_settings` | Single-row dynamic runtime config | `id` (fixed 1), `overrides` (JSONB), `version`, `updated_at`, `updated_by` |
| `audit_events` | Central audit trail | `id`, `kind`, `action`, `actor_id`, `target_type`, `target_id`, `details` (JSONB), `source_ref`, `at` |
| `audit_dead_letter` | Fallback store for failed audit writes | `id`, `kind`, `payload` (JSONB), `error`, `attempted_at`, `replayed` |
| `chat_events` | Per-turn telemetry | `id`, `turn_id` (unique), `user_id`, `mode` (agentic/vector), `query`, `hit_count`, `max_similarity`, `out_of_domain`, `hallucination_blocked`, `ticket_created`, `citation_count`, `retrieve_ms`, `generate_ms`, `total_ms`, `cache_hit`, `tokens_in/out`, `meta` (JSONB) |
| `chat_feedback` | Sentiment votes | `turn_id` (PK, FK→`chat_events`), `feedback` (±1), `document_ids`, `chunk_ids`, `created_at` |
| `chat_conversations` | Persisted user chats (one row per conversation) | `id` (uuid PK), `user_id` (FK→`users.clerk_user_id`, ON DELETE CASCADE), `title`, `message_count`, `created_at`, `updated_at` (last activity; retention key) |
| `chat_messages` | Stored transcript messages per conversation | `id` (bigserial PK), `conversation_id` (FK→`chat_conversations`, ON DELETE CASCADE), `turn_id` (semantic link to `chat_events`, no FK), `role` (`user`/`assistant`), `content` (JSONB snapshot ≤256 KB), `created_at` |
| `chat_daily_stats` | Materialized view of daily aggregates (refreshed by the telemetry job) | `day`, `mode`, `total`, `p50_ms`, `p95_ms`, `hallucination_count`, `ood_count`, `tickets_created`, `self_serve_count`, `avg_max_similarity`, `unique_users`, `tokens_in/out` |

Indexes: HNSW `vector_cosine_ops` on `chunks.embedding` (partial — parent chunks excluded) and GIN `tsvector` on `chunks.tsv`.

### 5.1 Chat history retention & purge CLI

- **Retention**: saved chats (`chat_conversations` / `chat_messages`) auto-expire based on last activity (`updated_at`) after an admin-configured window (`chatHistoryRetentionDays`, editable in `/admin/settings`: Off / 30 / 120 / 365 days, default 120). **Off** (`0`) disables purging entirely.
- **`purge-chat-history [--days=N]`** (`rag-agent` CLI, modeled on `purge-chat-events`): deletes conversations whose last activity predates the cutoff (messages cascade). Supports `--dry-run` and asks for confirmation before deleting; windows under one day are refused without `--allow-sub-day`; while the admin window is Off, an explicit `--days` is mandatory for a one-off run. Each run writes an audit event (`kind='chat'`, `action='history_purged'`) with the deleted counts.

---

## 6. Rate Limiting & Caching Architecture

### Sliding-Window Rate Limiting
- **In-Memory LRU (`LruRateLimiter`)**: single-instance sliding-window limiter keyed per user/operation (`chat:${userId}`, `feedback:${userId}`). Default budget: 30 req / 60s with 5,000 active-key capacity.
- **Distributed (`UpstashRateLimiter`)**: production drop-in when `UPSTASH_REDIS_REST_URL` is set; Lua-scripted sorted sets (`ZADD`/`ZREMRANGEBYSCORE`) with keys `ratelimit:<key>` + per-key `:seq` counter.

### Turn Answer Cache
- **Deterministic keying**: normalizes whitespace/casing/punctuation; incorporates embedding + chat model identifiers and the runtime retrieval fingerprint (mode, similarity threshold, hybrid flag, reranker). Keys are `rag:answer:<sha256>`, namespaced per user — a cached answer is never served cross-user.
- **Providers**: `InMemoryAnswerCache` (LRU + TTL, 5,000-key sweep) for local dev; `UpstashAnswerCache` (Redis, TTL in **seconds** per `ANSWER_CACHE_TTL_SEC`, default 3600; value base64-wrapped) when Upstash is configured. Cache read/write failures are swallowed so caching never breaks the request path.

---

## 7. RAG Evaluation Harness

Located in `scripts/eval/` (`run.ts`, `harness.ts`, `golden.ts`):

```bash
pnpm eval          # local mock evaluation (deterministic deps)
EVAL_REAL=1 pnpm eval   # live model evaluation with LLM grading (scheduled weekly in CI)
```

- **Golden dataset (`golden.ts`)**: phrase-based — `{id, question, mustMention, forbidden?, refusalExpected?}`, no ground-truth answers or reference chunk IDs.
- **Metrics (0–1)**:
  - **Faithfulness**: LLM hallucination grader per response.
  - **Correctness**: lexical `mustMention` match ratio (not LLM-graded).
  - **ContextRelevancy**: approximation of retrieval recall (`mustMention` present in retrieved context).
  - A query passes when `faithfulness === 1`, no `forbiddenHit` in the answer, and `correctness >= 0.5`; refusal-expected queries are scored separately.
- **Thresholds**: `EVAL_FAITHFULNESS_THRESHOLD` (default 0.7) gates live runs; CI (`.github/workflows/eval.yml`) runs weekly and auto-opens/closes failure issues.

---

## 8. Deployment & Environment

The authoritative list of environment variables is `.env.example` (with per-var comments). This section documents the behavior of the environment-driven deployment features. Env vars are intentionally **not** covered in the README.

### 8.1 Clerk Custom-Domain Proxy & CSP (`CLERK_PROXY_URL` / `NEXT_PUBLIC_CLERK_PROXY_URL`)

When the Clerk instance runs behind a custom proxy domain (e.g. `clerk.example.com`), that origin serves the Clerk JS bundle, all frontend API calls, and the sign-in/account-portal iframes. `next.config.ts` derives the CSP from these variables:

- **Proxy origin** (`CLERK_PROXY_URL` or `NEXT_PUBLIC_CLERK_PROXY_URL`) is appended to every Clerk-related CSP directive (`script-src`, `style-src`, `img-src`, `connect-src`, `frame-src`, `form-action`, `child-src`).
- **Account portal origin** is auto-derived using Clerk's custom-domain convention: proxy `clerk.example.com` → `accounts.example.com`, added to `frame-src`.
- **Fallback**: when neither variable is set (local dev, Clerk dev mode, Docker builds — `.dockerignore` excludes `.env*` — or a domain without a registered proxy), the CSP allows only the default Clerk frontend API domain `https://*.clerk.accounts.dev`. See `resolveClerkProxyOrigins()` / `withClerkProxy()` in `next.config.ts`.
- **Runtime vs build**: `CLERK_PROXY_URL` is read from the server process env at boot, so the same Docker image can serve both modes (set it per-container at runtime). `NEXT_PUBLIC_*` variants are inlined at build time.
- **Vercel**: set `CLERK_PROXY_URL` for the Production environment (and Preview only if preview uses the same custom-domain instance). The Clerk Dashboard/DNS side (CNAMEs for the proxy and `accounts.` subdomain, prod instance keys `sk_live_`/`pk_live_`) is a Clerk-side prerequisite.

### 8.2 CSP baseline (static directives)

Regardless of the proxy mode, the CSP in `next.config.ts` always allows, in addition to `'self'`:
- `'unsafe-inline' 'unsafe-eval'` (required by the Clerk JS bundle) in `script-src`
- `https://challenges.cloudflare.com` in `script-src` / `connect-src` / `frame-src` (Cloudflare Turnstile bot protection)
- `https://*.clerk.services` in `connect-src`
- `https://vercel.live`, `https://*.clerk.accounts.dev`, Google OAuth and R2 preview origins in the directives where they were already present

### 8.3 Google Search Console Verification (`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`)

The root layout (`src/app/layout.tsx`) renders the `google-site-verification` meta tag **only** when `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` is set (build-time inlined). Unset → the tag is omitted entirely, which keeps clones and domain-less deployments clean of the owner's token. Set it for the production environment and verify ownership via Search Console, or verify your domain with another method (DNS TXT, file upload) instead.
### 8.4 Database roles, Row-Level Security, and how migrations apply

**Two-role split (since 2026-08-17).** The app and the migration tooling use different Postgres roles:

| Variable | Role | Privileges | Used by |
|---|---|---|---|
| `DATABASE_URL` | `rag_app` (least privilege) | `SELECT/INSERT/UPDATE/DELETE` on the 11 app tables, `USAGE, SELECT` on sequences, `USAGE` on schema `public`. **No** DDL, no `TRUNCATE`/`TRIGGER`/`REFERENCES`, no `_migrations` access, no role management, `NOBYPASSRLS` | App runtime (Next.js API routes, CLI, scripts that do DML) |
| `MIGRATION_DATABASE_URL` | DB owner (e.g. `neondb_owner`) | Full (owner) | `pnpm db:migrate` (`scripts/migrate.ts` → `scripts/apply-migration.mjs`), `drizzle-kit push`/`studio`/`introspect` |

Every tool that runs DDL prefers `MIGRATION_DATABASE_URL ?? DATABASE_URL` (`scripts/migrate.ts`, `scripts/apply-migration.mjs`, `drizzle.config.ts`). The app never holds the owner credential, so a leaked `DATABASE_URL` can no longer drop tables, plant triggers, or create roles.

**Row-Level Security.** RLS is enabled on all app tables (`app_settings`, `audit_dead_letter`, `audit_events`, `chat_conversations`, `chat_events`, `chat_feedback`, `chat_messages`, `chunks`, `documents`, `tickets`, `users`) with one policy each (`rag_app_full_access`, `FOR ALL TO rag_app`). `_migrations` stays owner-only with no RLS. Any other role (including one holding a plain `SELECT` grant) sees **zero rows** — verified live with a probe role. If a fresh database is provisioned from scratch, replay the equivalent DDL as the owner: create `rag_app`, grant DML, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `CREATE POLICY … TO rag_app`.

**Manual runbook step for the chat history tables.** Migrations apply the DDL but not the live GRANT/RLS state — after applying `0018_chat_history.sql`, run the following as the DDL-capable owner (same pattern as the original rollout):

```sql
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_app_full_access ON chat_conversations FOR ALL TO rag_app USING (true) WITH CHECK (true);
CREATE POLICY rag_app_full_access ON chat_messages      FOR ALL TO rag_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations, chat_messages TO rag_app;
GRANT USAGE, SELECT ON SEQUENCE chat_messages_id_seq TO rag_app;
```

**Skipping this step makes the app see zero rows silently** — RLS is default-deny, so without a policy (and grants) for `rag_app` every history query returns nothing. Verify afterwards that `rag_app` reads and writes normally while a role without a policy sees zero rows.

**Migration flow (where DDL runs):**
1. **Local dev** — `pnpm db:migrate` or `pnpm build` (build runs `tsx scripts/migrate.ts` first); uses `MIGRATION_DATABASE_URL ?? DATABASE_URL`; local `docker compose` DBs are owned by the local user, so `DATABASE_URL` alone is fine.
2. **CI (GitHub Actions)** — `.github/workflows/ci.yml`: the "Prepare test database" step migrates a fresh Neon test branch (the setup script writes an owner-grade `DATABASE_URL` into `.env.test`); the "Migrate production database" step (master branch only) runs with `MIGRATION_DATABASE_URL` from GitHub secrets.
3. **Vercel production builds** — `vercel.json` runs `next build` only; it never applies migrations. Production DDL runs in the approval-gated `deploy` job in `.github/workflows/ci.yml` with `MIGRATION_DATABASE_URL`. Vercel still needs `DATABASE_URL` at runtime.

### 8.5 QStash ingest queue reliability (DLQ + sweeper)

Uploads are processed asynchronously through QStash (`POST /api/admin/ingest-worker`). Delivery is retried up to 3 times; after that the message is forwarded to the **dead-letter endpoint** instead of being dropped silently:

- **`QSTASH_DLQ_URL`** — set it to `https://<app>/api/admin/ingest-dead-letter` (public route, gated by the QStash signature exactly like the ingest worker: `Receiver.verify` with `QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`, 5-minute replay window, 1 MB cap). The handler persists the failure into the existing `audit_dead_letter` table with `kind='ingest'` (payload holds `documentId`, error, timestamp) — no new table, no migration — and flips the document to `failed` so it is visible in the admin UI.
- **Sweeper** — `GET /api/admin/queue/sweep` is for the Vercel cron and requires `Authorization: Bearer <CRON_SECRET>`; `POST` is admin-authenticated. It marks documents stuck `queued` past 24 h as `failed` — a backstop for failures that never reached the DLQ (e.g. DLQ delivery itself failing, or old messages enqueued before DLQ was configured). The route is public at the middleware level but rejects an unauthenticated GET with 405.
- Both routes are in the Clerk middleware `isPublicRoute` list **only** because each enforces its own signature/secret; they are not browsable by anonymous users.
