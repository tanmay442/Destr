# Tests

## Unit + integration (Vitest)

336 tests across 42 files. Run with `pnpm test` (single run) or
`pnpm test:ui` (interactive). Highlights:

- `src/app/api/chat/route.test.ts` — 401 / 429 paths, the
  `searchDocumentation` and `createSupportTicket` tool wiring
  (searchChunks shape, 800-char cap, user-supplied limit, captured-
  citation emission), the Clerk identity override in
  `createSupportTicket`, the first-turn pre-fetch (no header on
  empty `lastUserText`, chunks injected on the first turn,
  pre-fetched chunks surface as `data-citation` parts without a
  tool call, no pre-fetch on follow-up turns), and the Session-10
  answer cache (cache hit short-circuits generation; cache miss
  writes the first-turn answer; follow-up turns skip the cache)
- `packages/infrastructure/src/auth/answer-cache-key.test.ts` —
  cache-key normalisation stability (whitespace/case/punctuation)
  and model-id pinning (embedding + chat model change the key)
- `packages/application/src/rag/agentic-search.test.ts` —
  query-rewrite → grade → verify loop, out-of-domain refusal
- `src/app/api/admin/documents/[id]/blob/route.test.ts` —
  inline PDF preview route (auth + content-type + 404 paths)
- `src/app/api/admin/tickets/[ticketId]/route.test.ts` —
  single-ticket GET/PATCH (auth + 404 + status validation + notes update)
- `src/app/api/admin/users/[clerkId]/role/route.test.ts` —
  role update route (auth + invalid role + forbidden + happy path)
- `src/components/ChatInterface.test.tsx` — chat frame layout
  (`flex-1 min-h-0 overflow-y-auto`) + streaming / citations
  rendering
- `src/app/api/admin/{users,documents,tickets}/...` — 403 / 400 / 404 /
  409 paths and the happy path
- `src/app/(app)/admin/actions.test.ts` — every admin server action 403s for
  non-admin and forwards the right shape on success
- `src/proxy.test.ts` — middleware route gating (public / signed-in /
  admin)
- `packages/application/src/rag/__tests__/search.test.ts` —
  vector search error propagation and success path
- `packages/application/src/rag/__tests__/ingest.integration.test.ts` —
  PDF ingest pipeline: chunk insertion, hash dedup, transactional
  document replacement (insert-before-delete with TransactionRunner),
  empty-text and API-failure error paths
- `packages/application/src/rag/__tests__/ingest-prechunked.test.ts` —
  pre-chunked Markdown upload: parsing, embedding, metadata writing
- `packages/application/src/rag/__tests__/parseAndEmbed.test.ts` —
  chunk parse + embed helper
- `packages/application/src/auth/__tests__/users.test.ts` —
  `setUserRole`: audit logging, invalid role, user-not-found
- `packages/application/src/admin/__tests__/tickets.test.ts` —
  `updateTicket`: missing ticket, invalid transition, race condition,
  notes-only update, valid transitions; `createTicket`: generated ID,
  audit logging, insert failure; `isTicketStatus`, `VALID_TRANSITIONS`
- `packages/application/src/admin/__tests__/documents.test.ts` —
  `restoreDocument`: missing doc, non-deleted, expired window,
  within window; `softDeleteDocument`: missing doc, happy path
- `packages/application/src/admin/__tests__/reingest.test.ts` —
  `reingestAll`: pagination across multiple pages, idempotent enqueue
- `packages/application/src/__tests__/result.test.ts` — `Result<T,E>`
  helpers (`ok`/`err`/`unwrap`)
- `packages/cli/src/__tests__/init.test.ts` — CLI `init` command
- `packages/infrastructure/src/chunking/index.test.ts` — strategy registry
- `packages/infrastructure/src/chunking/strategies/parent-child.test.ts` —
  parent-child / window resolution
- `packages/infrastructure/src/db/__tests__/insert-chunks.test.ts` —
  chunk insertion (note: one pre-existing `Client` import typecheck noise
  unrelated to the test logic)
- `packages/infrastructure/src/llm/doc-summarizer.test.ts` — CCH header
  title/summary generation
- `packages/infrastructure/src/llm/graders.test.ts` — query-rewrite /
  document-grade / hallucination graders
- `packages/infrastructure/src/llm/index.test.ts` — LLM adapter wiring
- `packages/infrastructure/src/markdown/md-parser.test.ts` — pre-chunked
  Markdown delimiter + YAML-ish meta parsing
- `packages/infrastructure/src/pdf/unpdf-parser.test.ts` — PDF text extraction
- `packages/infrastructure/src/queue/index.test.ts` — ingest queue adapter
- `scripts/apply-migration.test.ts` — migration runner helper
- `scripts/seed-docs.test.ts` — doc seeding
- `scripts/setup-test-db.test.ts` — test DB provisioning
- `src/app/api/admin/audit/route.test.ts` — audit log GET (auth + filter)
- `src/app/api/admin/ingest-worker/route.test.ts` — QStash ingest worker
- `src/app/api/admin/reingest/route.test.ts` — re-ingest POST (admin)
- `src/app/api/admin/settings/route.test.ts` — settings GET (admin)
- `src/lib/__tests__/sanitize.test.ts` — `escapeHtml` / `sanitizeText`
- `src/__tests__/chunking-strategy.test.ts` — chunking-strategy config
  resolution
- `src/lib/__tests__/http.test.ts` — `respond()` edge cases
  (ConflictError→409, GoneError→410, ExternalServiceError→502,
  non-Error→500), `isActionError`, `toActionResult`, `toSafeError`
- `src/__tests__/composition.test.ts` — `parseQueryPagination` edge
  cases (empty string, Infinity, negative offset, zero offset),
  `parsePageParam`

## Repository layout

```
src/
├── app/
│   ├── (marketing)/        # Public landing (no app chrome)
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── (app)/              # Authenticated shell (sidebar + mobile drawer)
│   │   ├── layout.tsx
│   │   ├── chat/page.tsx
│   │   └── admin/          # requireAdmin() guard + admin pages + actions
│   ├── api/{chat,admin}/   # Tool-driven RAG + admin API routes
│   ├── sign-in/[[...sign-in]]/page.tsx
│   ├── sign-up/[[...sign-up]]/page.tsx
│   ├── layout.tsx          # ClerkProvider, html/body, fonts
│   └── globals.css         # Dark "obsidian slate" CSS tokens
├── components/
│   ├── ChatInterface.tsx
│   ├── app/AppSidebar.tsx  # Unified sidebar + mobile drawer (Client)
│   ├── marketing/          # MarketingHero, MarketingFooter, MarketingAuthCard, MarketingTechMarquee, MarketingQuickStart
│   └── icons/GithubIcon.tsx
├── lib/
│   ├── http.ts             # respond() + respondResult() + toSafeError() + toActionResult() + isActionError()
│   ├── logger.ts           # Structured JSON logger
│   ├── sanitize.ts         # escapeHtml() + sanitizeText()
│   └── config/             # App-level config types
├── proxy.ts                # clerkMiddleware (Next 16 convention)
└── ...
config/
├── app.config.ts           # Org name, persona, admin emails, out-of-scope topics
└── constants.ts            # Centralised business-logic constants
scripts/                    # setup, seed, migration scripts
```

## Running tests with real credentials present

Some unit tests assert a "missing env var" / "should throw when absent"
path (e.g. the Upstash query-stats / rate-limiter "throws when env vars
are missing" tests, and `validateEnv` requiring QStash signing keys when
`QSTASH_TOKEN` is set). These tests are **environment-sensitive**: they only
pass when the relevant vars are genuinely absent.

`vi.unstubAllEnvs()` only removes stubs that vitest itself created — it does
**not** remove real `process.env` values loaded from
`.env.realCredentials.local` or an already-populated dev shell. When real
`UPSTASH_REDIS_*` / `QSTASH_*` credentials are present, the guard rails never
trigger and those assertions invert (the test expects a throw / a "missing"
report and gets neither).

These tests were made **self-isolating** (no behavior change, test files
only) by explicitly stubbing the relevant vars to `''` inside the affected
assertions, so the suite is green in any environment:

- `packages/infrastructure/src/auth/upstash-query-stats.test.ts`
- `packages/infrastructure/src/auth/upstash-rate-limiter.test.ts`
- `src/lib/__tests__/env.test.ts`

After this fix the full suite passes **336/336** even when
`.env.realCredentials.local` is sourced (`set -a && . ./.env.realCredentials.local && set +a && pnpm test`).

If you add a new test that asserts "missing var" behavior, stub the var to
`''` (not just `vi.unstubAllEnvs()`) so it does not depend on the ambient
environment.

## CI

`pnpm test:ci` provisions a Neon test branch, runs the full Vitest
suite, and tears the branch down. Requires `NEON_API_KEY` and
`NEON_PROJECT_ID` in `.env.local`. When these are absent the
branching step is skipped and the suite runs against whatever
database `DATABASE_URL` points to.
