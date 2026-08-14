# RAG Knowledge Agent — Technical Reference Manual

This document provides a comprehensive technical reference for the RAG Knowledge Agent architecture, tech stack, authentication model, admin operations, database schema, and operational subsystems.

---

## 1. Technology Stack

| Component | Technology | Description |
|---|---|---|
| **Framework** | Next.js 16 (App Router) | React 19, Turbopack, Server Actions |
| **AI / RAG** | Vercel AI SDK v6 | Tool-calling, streaming, grounded citations |
| **Database** | Neon Postgres + pgvector | HNSW vector similarity search & BM25 hybrid ranking |
| **ORM** | Drizzle ORM | Type-safe schema definition and migrations |
| **Auth** | Clerk (`@clerk/nextjs` v7) | Middleware-gated sessions & RBAC roles |
| **Testing** | Vitest & Testing Library | Unit, integration, and port contract suites |
| **Styling** | Tailwind CSS v4 | Achromatic obsidian slate design system |

---

## 2. Modular Clean Architecture Deep Dive

The business logic is organized into a 4-layer monorepo inside `packages/`:

```
rag_agent/
├── packages/
│   ├── domain/         # @app/domain — Pure types, Zod schemas, Result<T,E>, port interfaces
│   ├── application/    # @app/application — Pure use-cases returning Result<T, DomainError>
│   ├── infrastructure/ # @app/infrastructure — Drizzle repos, AI SDK adapters, PDF parsers
│   └── cli/            # @app/cli — `rag-agent` management CLI (init, setup, seed, db-migrate)
└── src/                # Next.js App Router shell, UI components, and composition root
```

### Modularity Highlights & Port Design
- **Environment & Config Abstraction (`@app/domain`, `@app/infrastructure`)**:
  `EnvSource` and `RuntimeConfig` ports decouple environment variable loading from ambient global `process.env`, enabling deterministic configuration injection and testing.
- **Provider Registry & Factory Injection (`packages/infrastructure/src/llm/`)**:
  Multi-provider LLM, embedding, and reranker implementations (`Google`, `OpenAI`, `Ollama`, `Cohere`, `Local Cross-Encoder`) are selected dynamically via factory functions and isolated provider registries.
- **Interface-Segregated Chunk Repositories (`packages/domain/src/ports.ts`)**:
  `ChunkRepository` is segregated into fine-grained ports (`VectorSearch`, `LexicalSearch`, `ChunkStore`, `TransactionalChunkWriter`), enabling independent substitution of storage and search mechanisms.
- **Runtime-Neutral Content Parsing**:
  `ContentParser` accepts `Uint8Array` binary buffers rather than Node.js-specific `Buffer` objects, enabling seamless portability across serverless, edge, and browser runtimes.
- **Centralized Composition Root (`packages/infrastructure/src/core.ts` & `src/composition.ts`)**:
  Single dependency-injection root via `buildCoreDeps()` memoizes shared database connection pools and timers on the default environment while allowing isolated instantiations for testing.
- **Decoupled Application Use-Cases (`@app/application`)**:
  Chat turns, document ingestion, support tickets, and analytics calculations are written as pure functions returning typed `Result<T, DomainError>` objects, completely decoupled from Next.js request/response APIs.
- **Port Contract Testing Matrix (`packages/infrastructure/src/**/contracts/`)**:
  Shared contract assertion suites guarantee that all multi-implementation ports (`RateLimiter`, `AnswerCache`, `IngestQueue`, `BlobStorage`, `EmbeddingService`, `Reranker`) satisfy identical functional contracts.

### Architecture Layer Rules (Enforced by `pnpm arch`)

| Layer | May Import | May NOT Import |
|---|---|---|
| **`domain`** | `zod` | `application`, `infrastructure`, `cli`, `src/`, `drizzle-orm`, `@ai-sdk/*`, `next`, Node built-ins |
| **`application`** | `domain` | `infrastructure`, `src/app`, `src/components`, `drizzle-orm`, `@ai-sdk/*`, `next` |
| **`infrastructure`** | `domain`, `drizzle-orm`, `@ai-sdk/*`, `clerk`, `unpdf`, `pg` | `application`, `src/app`, `src/components`, `next` (scoped Clerk request exception only) |
| **`src/`** | `application`, `domain`, `src/lib/*`, `@ai-sdk/react`, `next`, `@clerk/nextjs` | `drizzle-orm`, `pg`, `unpdf`, `@app/infrastructure` (except composition root) |
| **`cli`** | `application`, `infrastructure`, `dotenv` | `src/app`, `src/components` |

---

## 3. Identity, Auth & Role-Based Access Control (RBAC)

### Provider & Architecture
- **Provider**: Clerk (`@clerk/nextjs` v7).
- **Routes**: `/sign-in` and `/sign-up` utilize Clerk hosted components (`<SignIn />` / `<SignUp />`).
- **Role Model**: Every user carries a role of `admin` or `user`. The local `users` table holds the authoritative role, while Clerk's `publicMetadata` mirrors the role for fast JWT-based middleware checks.
- **Admin Auto-Promotion**: A comma-separated list of emails in `ADMIN_EMAILS` automatically promotes users to `admin` on their first sign-in once Clerk marks their email address as **verified**. Verified admin-email holders can access `/admin` immediately even prior to database row creation.

### Clerk JWT Session Template Configuration
To enable sub-millisecond edge route gating without round-tripping to Clerk Backend SDKs on every request:
1. Navigate to **Clerk Dashboard** -> **Sessions** -> **Customize session token**.
2. Set the JSON template:
   ```json
   {
     "metadata": "{{user.public_metadata}}"
   }
   ```
3. This projects `publicMetadata.role` into `session.metadata.role`, which `src/proxy.ts` (Next.js 16 middleware) reads as its fast path.

### Route Gating & Protection Matrix
- **`src/proxy.ts`** executes `clerkMiddleware`.
  - `/chat(.*)`, `/admin(.*)`, `/api/chat(.*)`, `/api/admin(.*)` require an active authenticated session.
  - `/admin(.*)` and `/api/admin(.*)` additionally require `role === 'admin'`.
  - Non-admin page visits redirect to `/chat`; non-admin API calls return `HTTP 403 Forbidden`.
  - The cron endpoint `/api/admin/analytics/rollup` allows authorized bypass when a valid `Authorization: Bearer <CRON_SECRET>` header is supplied.
- **Server Action Gating**: Every admin server action in `src/app/(app)/admin/actions.ts` invokes `requireAdmin()` as its first check.

---

## 4. Admin Console Subsystems

### Overview (`/admin`)
- Metric stat cards: total documents, indexed chunks, active tickets, open tickets, registered users.
- Live stream of the latest 10 audit events.

### Document Management (`/admin/documents` & `/admin/upload`)
- **Upload**: Accepts PDF and Markdown files. Processes chunking and vector embeddings via configured strategy.
- **Inline PDF Preview**: Secure iframe rendering backed by `/api/admin/documents/[id]/blob`.
- **Soft Deletion**: Deleted documents enter a 7-day recovery grace period before permanent purging.
- **Recount All**: A server action (`recountAllChunksAction`) re-synchronizes document chunk counts directly from the `chunks` table.

### Support Ticket Intelligence (`/admin/tickets`)
- **Fixed Table Layout**: Viewport-bounded columns with compact timestamps to prevent horizontal overflow.
- **Ticket Drawer Portal**: Deep-linked query param (`?ticket=<id>`) mounts the ticket details, issue description, assignees, notes thread, and status controls.
- **State Machine Transitions**: Validates transitions (`created` -> `in_progress` -> `resolved` / `closed`). Reopening closed tickets is prohibited (`closed -> created` is rejected).
- **Deterministic Identifiers**: Uses collision-resistant UUIDs formatted as `TKT-<8-hex-chars>`.

### Analytics & Telemetry Engine (`/admin/analytics`)
Organized across four specialized reporting tabs:
1. **Statistics Tab**:
   - Aggregate chat turns, hallucination blocks, out-of-domain refusals, and self-serve success rate.
   - 12-week SVG trend charts (`LineChart`) with a 5% hallucination warning threshold marker.
   - Estimated LLM token cost breakdown and 7-day usage `ActivityBars`.
2. **Performance Tab**:
   - Answer cache-hit rate and weekly trend.
   - Retrieval, generation, and total latency breakdown (`BarList` showing p50 and p95).
   - Agentic vs. Standard vector search comparative metrics (cost, similarity, query-length distribution).
   - Top 5 cache-buster queries and agentic retry rate.
3. **Feedback Tab**:
   - User 👍/👎 feedback distribution (helpful vs. unhelpful percentage).
   - Per-document sentiment scoring and thumbs-down hotspot tracking.
   - Document utility rankings and zero-hit document detection.
4. **Tickets Tab**:
   - Weekly ticket generation volume.
   - Turns-to-ticket distribution (measuring user struggle before escalation).
   - First-response and resolution time medians computed from audit event histories.

### Comprehensive Audit Log (`/admin/audit`)
- Consolidated logging over the `audit_events` table.
- Filterable by `kind` (`document`, `ticket`, `user`, `settings`), `action`, `actor`, and date range.
- **Settings Diffs & One-Click Revert**: Settings updates record granular JSON diffs (`{ key: old -> new }`). Admins can click **Revert** to restore prior configurations via an audited `PUT`.
- **Dead-Letter Resiliency (`audit_dead_letter`)**: Audit writes are non-blocking. If an audit write encounters a transient error, the payload and error details are persisted to `audit_dead_letter` for manual replay without interrupting user operations.

### Runtime Configuration & Precedence (`/admin/settings`)
Driven by the Zod introspection descriptor at `GET /api/admin/settings/schema`. Admins can dynamically adjust retrieval modes, chunking strategies for new uploads, agent persona, and guardrail rules with optimistic concurrency control.

#### 4-Layer Precedence Hierarchy (Highest wins):
1. **Environment Lock (`APP_SETTINGS_LOCK`)**: Comma-separated dot-paths (e.g. `retrievalMode,hybridEnabled`) locked read-only in the UI.
2. **Database Overrides**: Rows persisted in the `app_settings` singleton table (`id = 1`).
3. **Application Config Defaults**: `config/app.config.ts`.
4. **Domain Schema Defaults**: `appConfigSchema` definitions in `@app/domain`.

---

## 5. Database Schema Reference

The database uses PostgreSQL with the `pgvector` extension, managed via Drizzle ORM.

| Table Name | Description | Key Columns |
|---|---|---|
| `documents` | Ingested PDF and Markdown source files | `id`, `file_name`, `file_hash`, `chunk_count`, `deleted_at` |
| `chunks` | Text chunks with vector embeddings and BM25 search indices | `id`, `document_id`, `chunk_index`, `content`, `embedding`, `section_title`, `metadata` |
| `tickets` | Support escalation tickets | `id` (`TKT-*`), `user_id`, `issue_description`, `status`, `assigned_to`, `created_at` |
| `ticket_notes` | Comments and internal investigation notes on tickets | `id`, `ticket_id`, `actor_id`, `note`, `created_at` |
| `users` | Local mirror of Clerk user identities and RBAC roles | `id`, `clerk_id`, `email`, `role`, `created_at` |
| `app_settings` | Single-row dynamic runtime configuration | `id` (fixed `1`), `settings` (JSONB), `version`, `updated_at` |
| `audit_events` | Central audit trail across all operations | `id`, `kind`, `action`, `actor_id`, `details` (JSONB), `created_at` |
| `audit_dead_letter` | Fallback store for transient audit write failures | `id`, `kind`, `payload` (JSONB), `error_message`, `created_at` |
| `chat_events` | Per-turn telemetry and execution metrics | `id`, `turn_id`, `user_id`, `mode`, `latency_ms`, `cache_hit`, `meta` (JSONB) |
| `chat_feedback` | User sentiment votes on assistant answers | `id`, `turn_id`, `user_id`, `vote` (+1/-1), `document_ids`, `created_at` |
| `chat_daily_stats` | Materialized view aggregating 12-week telemetry trends | `date`, `total_turns`, `cache_hits`, `hallucinations`, `avg_similarity` |

---

## 6. Rate Limiting & Caching Architecture

### Sliding-Window Rate Limiting
- **In-Memory LRU (`LruRateLimiter`)**: Single-instance sliding-window limiter keyed per user and operation (`chat:${userId}`, `feedback:${userId}`). Default budget: 30 requests / 60s with a 5,000 active key capacity.
- **Distributed Redis (`UpstashRateLimiter`)**: Production drop-in replacement utilizing Upstash Redis sorted sets (`ZADD` / `ZREMRANGEBYSCORE`).

### Turn Answer Cache
- **Deterministic Keying**: Normalizes prompt whitespace, casing, and punctuation while incorporating model identifiers and runtime retrieval mode.
- **Storage Providers**:
  - `InMemoryAnswerCache`: LRU cache with TTL auto-eviction for local development.
  - `UpstashAnswerCache`: Redis-backed key-value store with millisecond TTL expiry.

---

## 7. RAG Evaluation Harness

The repository includes a comprehensive RAG evaluation suite located in `scripts/eval/`:

```bash
# Run local mock evaluation over the golden dataset
pnpm eval

# Run live model evaluation with real LLM grading (scheduled CI)
EVAL_REAL=1 pnpm eval
```

- **Golden Dataset (`scripts/eval/golden.ts`)**: Curated questions, ground-truth answers, and reference context chunks.
- **Grading Metrics**:
  - **Faithfulness**: LLM assertion that generated answers are grounded strictly in retrieved context without hallucination.
  - **Answer Relevance**: LLM verification that the answer directly addresses user intent.
  - **Retrieval Precision & Recall**: Context chunk matching against expected document references.
