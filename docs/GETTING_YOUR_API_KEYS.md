# Getting your API keys

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
| Upstash Redis | Prod rate limiting + query stats + answer cache | https://console.upstash.com | Yes — 10k commands/day |
| Upstash QStash | Async ingest (optional) | https://console.upstash.com → QStash | Yes — 500 msgs/day |

## Clerk (auth — always required, even locally)

1. Go to https://dashboard.clerk.com → **Create application**.
2. Name it (e.g. "RAG Support Agent"). Select your preferred sign-in
   methods (Email + Google at minimum).
3. From the application's **API Keys** page, copy:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — starts with `pk_test_`
     (development) or `pk_live_` (production). The `NEXT_PUBLIC_`
     prefix means it's safe to expose to the client.
   - `CLERK_SECRET_KEY` — starts with `sk_test_` or `sk_live_`. **Never
     commit this.**
4. **Set up the JWT template (required for the role fast-path in
   `proxy.ts`)**: Dashboard → **Sessions** → **Customize session token**
   → set the template body to:
   ```json
   { "metadata": "{{user.public_metadata}}" }
   ```
   This projects `publicMetadata.role` into the session token's
   `metadata.role` claim, which the middleware reads without calling
   the Clerk Backend SDK on every request.
5. **For Vercel Marketplace auto-provision** (optional but convenient):
   In the Vercel dashboard → Storage → Marketplace → add Clerk. This
   auto-sets both keys in your Vercel project env vars.

## Neon (prod database)

1. Go to https://neon.tech → **Sign up** (GitHub/Google).
2. **Create a project** → name it → select the region closest to your
   Vercel deployment region (e.g. `us-east-1` if Vercel is `iad1`).
3. Copy the **pooled connection string** (uses port `6543`, hostname
   `-pooler`); this goes into `DATABASE_URL`. It should end with
   `?sslmode=require`.
4. **Enable pgvector**: open the Neon SQL editor and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
5. For preview deploys: copy `NEON_API_KEY` (Settings → API keys) and
   `NEON_PROJECT_ID` (Settings → Project ID). When both are in Vercel
   env vars, `pnpm test:ci` provisions a per-branch Neon database for
   each Vercel preview deploy.

## Google AI Studio (prod embeddings)

1. Go to https://aistudio.google.com/apikey → **Create API key**.
2. Copy the key into `AI_STUDIO_KEY`.
3. The default model `gemini-embedding-001` produces 768-dim vectors —
   matches the pgvector column. Don't change `EMBEDDING_DIMENSION`
   unless you switch to a different embedding model.

## OpenAI-compatible chat (prod chat)

The app uses `@ai-sdk/openai`'s `createOpenAI`, so any
OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, Together,
local LM Studio, etc.).

1. Get an API key from your provider.
2. Set `CUSTOM_LLM_API_KEY` = the key.
3. Set `CUSTOM_LLM_BASE_URL` = the endpoint (e.g.
   `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`).
4. Set `LLM_MODEL` = the model id (e.g. `gpt-4o-mini`,
   `anthropic/claude-3.5-sonnet` for OpenRouter).

## Cloudflare R2 (prod blob storage)

1. Go to https://dash.cloudflare.com → **R2 Object Storage** (sign up
   if needed; requires a Cloudflare account + payment method on file
   even for the free tier).
2. **Create a bucket** — name it (e.g. `rag-agent-docs`). Note the
   region (auto is fine).
3. **Create an API token**: R2 → **Manage R2 API Tokens** → **Create
   API Token** → permissions: **Object Read & Write** on your bucket.
   Copy:
   - `R2_ACCESS_KEY_ID` — the access key id
   - `R2_SECRET_ACCESS_KEY` — the secret access key
4. `R2_ACCOUNT_ID` = your Cloudflare account ID (visible in the
   dashboard sidebar or URL).
5. `R2_BUCKET` = the bucket name you created.
6. **CORS** (needed if the PDF preview route redirects to a signed
   R2 URL that the browser fetches): R2 → your bucket → **Settings** →
   **CORS Policy** → add:
   ```json
   [{
     "AllowedOrigins": ["https://your-app.vercel.app", "http://localhost:3000"],
     "AllowedMethods": ["GET", "HEAD"],
     "AllowedHeaders": ["*"],
     "ExposeHeaders": ["Content-Length", "Content-Type"],
     "MaxAgeSeconds": 3600
   }]
   ```
7. If the CSP in `next.config.ts` blocks the R2 domain in `frame-src`
   or `img-src`, add `https://*.r2.dev` (or your custom R2 domain) to
   those directives.

## Upstash Redis (prod rate limiting + query stats + answer cache)

1. Go to https://console.upstash.com → **Create Database**.
2. Name it, select the **same region** as your Vercel deployment
   (latency matters — every `/api/chat` call hits Redis).
3. Copy:
   - `UPSTASH_REDIS_REST_URL` — the REST URL (ends with `.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` — the REST token
4. Without these, the app falls back to in-memory rate limiting — fine
   for local dev, but on Vercel each instance gets its own limit (N×
   the intended budget). Set these for any multi-instance deploy. The
   **answer cache** (Session 10) shares this same Redis instance (no
   second connection); without it, caching falls back to an in-memory
   store that is lost on restart.

### Session 10 env vars (answer cache, tracing, eval)

| Var | Default | Purpose |
|-----|---------|---------|
| `ANSWER_CACHE_ENABLED` | `true` | Toggle the first-turn answer cache |
| `ANSWER_CACHE_TTL_SEC` | `3600` | Cache TTL in seconds |
| `TRACE_ENABLED` | `false` | Emit `rag.*` tracing spans via the logger |
| `EVAL_FAITHFULNESS_THRESHOLD` | `0.7` | `pnpm eval` CI gate (mean faithfulness) |

All four are optional and default safely; no key is required to run
locally. `pnpm eval` runs a mock harness with zero external deps; set
`EVAL_REAL=1` to grade against a keyed provider.

## Upstash QStash (async ingest — optional)

1. Go to https://console.upstash.com → **QStash**.
2. Copy:
   - `QSTASH_TOKEN` — from the QStash dashboard
   - `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` —
     from **Settings** → **API Keys**. These two are used for
     signature rotation; the worker verifies with both so a key
     rotation doesn't break in-flight messages.
3. Set `QSTASH_INGEST_WORKER_URL` = the public URL of your deployment
   (e.g. `https://your-app.vercel.app`). QStash calls back over the
   public internet, so localhost won't work — use a Vercel preview or
   production URL.
4. Without `QSTASH_TOKEN`, all uploads go through the synchronous path
   (≤4 MB, blocks until ingest completes). Fine for small docs.
