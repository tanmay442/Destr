# RAG Support Agent

Serverless AI customer support agent built on Next.js 16, the Vercel AI
SDK v6, and Drizzle ORM on Neon Serverless Postgres with pgvector.
Users sign in with Clerk, ask questions in a chat UI, and receive
cited answers drawn from uploaded PDF documentation.

## Quick start

```bash
git clone https://github.com/tanmay442/rag_agent.git && cd rag_agent
docker compose up -d db          # Postgres + pgvector
pnpm install
pnpm db:push                     # Create tables in local DB
pnpm dev                         # http://localhost:3000
```

That's it. The defaults in `.env.example` boot against the Docker
Postgres with Ollama for embeddings and chat — no external API keys
needed for local development.

> **Note:** You still need Clerk keys for auth (`CLERK_SECRET_KEY` and
> `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`). Copy `.env.example` to
> `.env.local` and add them. Without Clerk, the app boots but you
> can't sign in.

### Zero-key local (with Ollama)

```bash
docker compose --profile ollama up -d   # Postgres + Ollama
# Pull the models (first time only):
docker compose exec ollama ollama pull embeddinggemma:latest
docker compose exec ollama ollama pull gemma4:e2b
pnpm install
pnpm db:push                            # Create tables in local DB
pnpm dev
```

### Deploy to Vercel

1. Push to GitHub.
2. Import the repo in Vercel.
3. Add environment variables from `.env.example` — see the
   "Getting your API keys" section below for where to get each one.
4. Deploy. `pnpm build` runs migrations then builds, unless `NEXT_SKIP_MIGRATIONS=1` is set (CI sets this and migrates in a separate, `main`-only step).

> **Reranking on Vercel:** `RERANKER_PROVIDER` is a **3-way feature flag**
> (`cosine` | `local` | `cohere`). **Default is `cosine`** — the original
> bi-encoder ordering with no reranker loaded (zero native deps, always works
> on serverless). Opt into a reranker explicitly:
> - `local` — on-device Xenova cross-encoder (needs native `onnxruntime` ~137 MB
>   + a runtime model download; **not reliable on serverless** — 250 MB function
>   cap, read-only FS). If it fails to load it auto-falls back to `cosine`.
> - `cohere` — hosted Cohere Rerank API (serverless-native, no native deps),
>   needs `COHERE_API_KEY`. Without the key it auto-falls back to `cosine`.
>
> In **every** mode, if the chosen reranker fails at runtime, `searchChunks`
> automatically falls back to cosine ordering (no crash). See the reranking
> block in `.env.example`.

### Getting your API keys

Every service the app needs is listed below, with where to sign up,
what to copy, and free-tier notes. For local-only development you can
skip every service except **Clerk** — Docker provides Postgres and
Ollama replaces the LLM providers.

| Service | Required for | Where to sign up | Free tier |
|---------|-------------|------------------|-----------|
| Clerk | Auth (always) | https://dashboard.clerk.com | Yes — generous free tier |
| Neon | Prod DB | https://neon.tech | Yes — 0.5 GB, auto-suspend |
| Google AI Studio | Prod embeddings | https://aistudio.google.com/apikey | Yes — free embeddings |
| OpenAI-compatible chat | Prod chat | Your provider (OpenAI, OpenRouter, Groq, etc.) | Varies |
| Cloudflare R2 | Prod blob storage | https://dash.cloudflare.com → R2 | Yes — 10 GB, zero egress |
| Upstash Redis | Prod rate limiting | https://console.upstash.com | Yes — 10k commands/day |
| Upstash QStash | Async ingest (optional) | https://console.upstash.com → QStash | Yes — 500 msgs/day |

See [docs/GETTING_YOUR_API_KEYS.md](docs/GETTING_YOUR_API_KEYS.md)
for detailed sign-up links and per-service walkthroughs.

## Stack

- **Framework:** Next.js 16 (App Router) with Turbopack
- **Auth:** Clerk (`@clerk/nextjs` v7) via Vercel Marketplace; Next 16
  `proxy.ts` (the renamed `middleware.ts`) for route gating
- **LLM:** Google AI Studio `gemini-embedding-001` (free 768-dim
  embeddings) + any OpenAI-compatible chat endpoint via
  `CUSTOM_LLM_*` env vars
- **Database:** Neon Serverless Postgres with the `pgvector` extension
  and HNSW cosine index
- **ORM:** Drizzle
- **Tooling:** Vitest, Testing Library, `drizzle-kit`
- **UI:** Dark-only "matte-black / achromatic-greyscale" design system via Tailwind v4 CSS-variable tokens in `src/app/globals.css` (no light variant). Route groups split the app: `(marketing)` for the public landing, `(app)` for the unified sidebar + mobile-drawer shell that wraps `/chat` and `/admin/*`.

### UI / design system

- **Styling:** Tailwind CSS v4 (utility-first, `@theme` / `@theme inline` tokens). All semantic colors derive from one achromatic-greyscale ramp in `src/app/globals.css` (`--background: #0a0a0a`, `--foreground: #f5f5f5`, …) so hover/focus/selected states stay coherent. Theming is forced dark via the `next-themes` `ThemeProvider` (`forcedTheme="dark"`, `enableSystem={false}`); there is no light variant.
- **Components:** [shadcn/ui](https://ui.shadcn.com) (`new-york` style) primitives live in `src/components/ui/` (button, card, dialog, select, input, label, badge, avatar, alert, separator, …). They are copied in (not a runtime dependency) and built on Radix UI for accessible behaviour.
- **Variants:** component variants use `class-variance-authority`; sizes/intents are Tailwind utility classes rather than bespoke CSS.
- **Structure:** the marketing landing lives in `src/components/marketing/`; the authenticated app shell (sidebar + mobile drawer) is `src/components/app/AppSidebar.tsx`.

## Reference

### Identity, auth, and roles

- **Provider:** Clerk (Vercel Marketplace). The integration auto-provisions
  `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- **Sign-in:** `/sign-in` and `/sign-up` use Clerk's hosted `<SignIn />` /
  `<SignUp />` components. Email+password and Google are enabled in the
  Clerk dashboard; the app is provider-agnostic.
- **Role model:** Every Clerk user carries a role of `admin` or `user`.
  The local `users` table holds the role, and any **verified** email
  listed in `ADMIN_EMAILS` is also treated as admin (so a listed email
  stays admin even if locally demoted). Clerk's `publicMetadata` mirrors
  the role for fast JWT-based middleware checks. Auto-promotion only
  happens once Clerk reports the email address as verified.
- **Bootstrap:** `ADMIN_EMAILS` is a comma-separated env var. The first
  time a user whose email is **verified** and listed in `ADMIN_EMAILS`
  signs in, they are auto-promoted to `admin` in the local DB. After
  that, admins promote others from `/admin/users`. A verified
  `ADMIN_EMAILS` user reaches `/admin` directly even before promotion,
  because middleware also admits verified admin-email addresses.
- **Route gating:** `src/proxy.ts` runs `clerkMiddleware`. `/chat(.*)`,
  `/admin(.*)`, `/api/chat(.*)`, and `/api/admin(.*)` require a signed-in
  user; `/admin(.*)` and `/api/admin(.*)` additionally require
  `role === 'admin'`. Non-admin page routes redirect to `/chat`;
  non-admin `/api/admin` requests return HTTP 403.
- **JWT template:** Middleware resolves the role from the **signed**
  session token (`metadata.role`) with no Clerk Backend SDK call, then
  falls back to the local `users` row, then to a verified `ADMIN_EMAILS`
  match. Configure a JWT template in the Clerk Dashboard (Sessions →
  Customize session token): `{ "metadata": "{{user.public_metadata}}" }`.
  This projects `publicMetadata.role` into the session token's
  `metadata.role` claim, which `src/proxy.ts` reads as its fast path.
  This template is required for correct middleware gating.
- **Action gating:** Every admin server action and API route calls
  `requireAdmin()` as its second line. Server actions return
  `{ error: 'Forbidden' }`; API routes return HTTP 403.
- **Security headers:** `next.config.ts` sets `X-Frame-Options: SAMEORIGIN`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Strict-Transport-Security` (HSTS), `Permissions-Policy`, a
  `Content-Security-Policy` header, and disables the `X-Powered-By`
  header. Server actions have a 4 MB `bodySizeLimit`.

### Admin console

- **`/admin` (Overview)** — Counts of docs, chunks, tickets, open
  tickets, and users, plus the latest 10 audit events.
- **`/admin/upload`** — File picker. After a successful upload shows a
  toast with the file name, status, and chunk count.
- **`/admin/documents`** — Searchable, paginated table. Each row has
  *Preview* (inline iframe over `/api/admin/documents/[id]/blob`),
   *Download*, *Delete* (soft delete with 7-day restore
  window), and *Hard delete* (cascade). A page-level *Recount all*
  button re-derives every document's chunk count from the
  `chunks` table (the `recountAllChunksAction` server action).
- **`/admin/tickets`** — Searchable, paginated list. The table is
  `table-fixed` with bounded column widths and a compact
  `YYYY-MM-DD HH:mm` Created column so it never overflows the
  viewport — no horizontal page scroll. Each row links to
  `?ticket=...`, which a client-side overlay (`ticket-overlay.tsx`)
  reads via `useSearchParams` and renders the existing `TicketDrawer`
  body into a portal: the full issue, a notes thread, a status
  select, an assignee select, and an "Add note" textarea. Status
  transitions are validated (no `closed → created/in_progress`).
  Ticket IDs are UUID-based (`TKT-<8-hex-chars>`) to avoid
  race conditions on concurrent creation.
- **`/admin/users`** — Searchable, paginated list of all Clerk users.
  Per-row *Promote / Demote* buttons.
- **`/admin/analytics`** — Read-only overview: summary counts, an activity
  donut, a 7-day activity timeline, and a recent-activity audit list.
- **`/admin/audit`** — Full audit log filterable by document id or
  ticket id. Document audit events: upload, replace, delete, restore.
  Ticket audit events: create, assign, status_change, note, impersonation, role_change.

  Audit writes are **best-effort for availability**: a failed audit write
  never fails the underlying operation (e.g. a role change or ticket update
  still succeeds). Instead of being silently dropped, a failed audit event
  is captured to the `audit_dead_letter` table (kind + JSON payload + error
  message) so compliance gaps are durable and replayable. Query that table
  to find and replay missed events; a logging outage is visible there rather
  than only in server logs. (Document-upload/delete audit events are written
  inside the same DB transaction as the operation, so they fail loudly with
  the operation rather than being dead-lettered.)
- **`/admin/settings`** — Read-only view of the current `CHUNKING_STRATEGY`,
  embedding model, parent/child chunk sizes, and a **Re-ingest All** button
  (`POST /api/admin/reingest`). The strategy/model are env-driven (read at
  startup + redeploy), so the dropdown is disabled and the copy tells the
  operator to edit the env var, redeploy, then run "Re-ingest All" to
  re-embed every document under the new config.

  The **Re-ingest All** endpoint (`POST /api/admin/reingest`) refuses to run
  when the ingest queue is a no-op (i.e. no `QSTASH_TOKEN`/inline worker is
  wired), returning HTTP 502 rather than a misleading "success" — a no-op
  queue would discard every enqueued document. Set `QSTASH_TOKEN` (and
  `QSTASH_INGEST_WORKER_URL`) so re-ingest actually re-embeds. When a sync
  inline queue is wired (local dev), each document is re-ingested inline.

### Rate limit

`packages/infrastructure/src/auth/lru-rate-limiter.ts` is a single-instance,
in-memory sliding-window limiter keyed by `chat:${userId}`. Default budget:
30 requests / 60 s, max 5 000 keys. When the 5 000-key cap is exceeded,
the least-recently-used keys are evicted (LRU). The 31st request returns HTTP 429 with a
`Retry-After` header. When the app moves to a multi-region deployment, swap
this for an Upstash hash; the call sites do not need to change.

### Shared utilities

| File | Purpose |
| --- | --- |
| `config/constants.ts` | Centralised business-logic constants (rate limits, thresholds, batch sizes) |
| `src/lib/sanitize.ts` | `escapeHtml()` and `sanitizeText()` for user-supplied free-text fields |
| `src/lib/logger.ts` | Lightweight structured JSON logger with `LOG_LEVEL` env gate (replace with pino for richer features) |
| `src/lib/http.ts` | `respond()`, `respondResult()`, `toSafeError()`, `toActionResult()`, and `isActionError()` for consistent error mapping |

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm configure` | One-command interactive setup wizard (prompts for env vars, migrates DB, seeds docs, runs smoke test) |
| `pnpm dev` | Run Next.js in dev mode |
| `pnpm build` | Run migrations then production build (set `NEXT_SKIP_MIGRATIONS=1` to build without migrating) |
| `pnpm start` | Run the production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest unit + integration suite |
| `pnpm test:ui` | Vitest with the interactive UI |
| `pnpm test:ci` | Provision a local test DB via `scripts/setup-test-db.ts` + run vitest, tearing the DB down after. Neon branch provisioning is attempted only when `NEON_API_KEY`/`NEON_PROJECT_ID` are present; otherwise the suite runs against whatever `DATABASE_URL` points to. |
| `pnpm db:push` | Apply the Drizzle schema to the configured DB (interactive) |
| `pnpm db:generate` | Generate SQL migrations from `packages/infrastructure/src/db/schema.ts` |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm db:migrate` | Run Drizzle migrations (`tsx scripts/migrate.ts`) |
| `pnpm dev:db` | Start the local Docker Postgres (`docker compose up -d db`) |
| `pnpm dev:ollama` | Start the local Ollama container (`docker compose --profile ollama up -d ollama`) |
| `pnpm eval` | Run the Session-10 evaluation harness (`scripts/eval/run.ts`). Mock mode is CI-safe (no keys); `EVAL_REAL=1` grades against a keyed provider; `EVAL_AUTOSEED=1` mines `QueryStats.top` |
| `pnpm seed` | Seed the configured DB from `./documents/` (`tsx scripts/seed-docs.ts`) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm cli` | Run the `rag-agent` CLI dispatcher (`--help` for usage) |
| `pnpm cli init` | Interactive first-time setup: org name, agent persona, admin emails, seed PDFs. Writes `config/app.config.ts` and re-seeds. |
| `pnpm cli seed` | Ingest every PDF in `./documents/` (overridable via `SEED_DOCS_DIR` or `--dir`) |
| `pnpm cli db-migrate` | Apply the Drizzle migrations + enable pgvector. Prompts for confirmation before the destructive `drizzle-kit push`; pass `--force` to skip the prompt |
| `pnpm arch` | Architecture boundary check via dependency-cruiser |

### Tests

The full unit + integration (Vitest) test catalog, CI setup, and
repository layout are documented in [docs/test.md](docs/test.md).

### Workspace layout

The business logic has been split into a 4-layer Clean Architecture
inside `packages/`:

```
packages/
├── domain/         # @app/domain — pure types, Zod schemas,
│                   #   Result<T,E>, DomainError hierarchy,
│                   #   port interfaces (repositories, services)
├── application/    # @app/application — use-cases that return
│                   #   Result<T, DomainError>. Imports only domain.
├── infrastructure/ # @app/infrastructure — Drizzle repos, AI SDK
│                   #   adapters, Clerk session, unpdf, bytea.
│                   #   Imports domain only (not application).
├── cli/            # @app/cli — `rag-agent` sub-commands:
                    #   init, setup, seed, db-migrate
```

`src/` is the Next.js app shell. `src/composition.ts` is the main
composition root where adapters are instantiated; `src/proxy.ts` also
instantiates the Clerk auth adapter for route gating. Routes import from
`@/composition` and call the use-cases.

#### Layer rules (enforced by `pnpm arch`)

| Layer            | May import                                | May NOT import                |
|------------------|-------------------------------------------|-------------------------------|
| `domain`         | zod                                       | application, infrastructure, cli, src/, drizzle, @ai-sdk, unpdf, next, node: built-ins |
| `application`    | domain, config/constants                  | infrastructure, src/app, src/components, drizzle, @ai-sdk, unpdf, next |
| `infrastructure` | domain, drizzle, @ai-sdk, clerk, unpdf, pg | application, src/app, src/components, next (except the Clerk `auth/` adapter may import `next/server` for `NextResponse`/request types) |
| `src/app`, `src/components` | application, domain, src/lib/http, src/lib/config, `@ai-sdk/react`, `next`, `@clerk/nextjs` | drizzle-orm, pg, unpdf, @app/infrastructure |
| `cli`            | application, infrastructure, dotenv       | src/app, src/components |

Run `pnpm arch` after any change that touches the import graph.

#### Boundary validation

Every route handler and server action parses its external input
through a Zod schema before it reaches a use-case:

- `src/lib/config/index.ts` — validates `config/app.config.ts` at server start
- `src/app/api/chat/request-schema.ts` — POST `/api/chat` body
- `src/app/api/admin/*/route.ts` — request bodies and URL params
- Server actions in `src/app/(app)/admin/actions.ts` — form input

Environment variables are validated at the point of use in each
infrastructure adapter:

- `packages/infrastructure/src/db/pool.ts` — validates `DATABASE_URL`
- `packages/infrastructure/src/llm/google-embedding-service.ts` — validates `AI_STUDIO_KEY`
- `packages/infrastructure/src/llm/openai-chat-service.ts` — validates `CUSTOM_LLM_API_KEY`, `CUSTOM_LLM_BASE_URL`
- `packages/infrastructure/src/auth/clerk-session.ts` (and `clerk-adapter.ts`) — parse `ADMIN_EMAILS`
- `src/lib/logger.ts` — gates on `LOG_LEVEL`

Use-cases return `Result<T, DomainError>`; `src/lib/http.ts` exports
`respond(result)` which maps `DomainError` to the right HTTP status
(ValidationError → 400, UnauthorizedError → 401, ForbiddenError → 403,
NotFoundError → 404, ConflictError → 409, GoneError → 410,
RateLimitedError → 429 with `Retry-After`, ExternalServiceError → 502).
