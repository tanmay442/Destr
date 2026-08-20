# Destr — Deep Code Review

- **Date:** 2026-08-20
- **Scope:** Full monorepo (~44k lines TS) — `packages/domain`, `packages/application`, `packages/infrastructure`, `src/` (server + UI), plus Docker/CI/config layer. `packages/cli` excluded (deferred by request).
- **Method:** Parallel per-slice deep reviews; every finding verified against source (many empirically reproduced). Read-only — nothing was modified.
- **Severity scale:** Critical / High / Medium / Low / Info.

## Overall verdict

No **Critical** or **High** findings anywhere. The codebase is well-hardened: defense-in-depth auth (every admin route independently re-verifies role; proxy is not the only gate), no SQL injection (all raw SQL parameterized; vector literals validated), no XSS (`react-markdown` without `rehype-raw`, `SafeLink` href allowlist, zero `dangerouslySetInnerHTML`), no secrets in client bundles, safe error envelopes with no message leakage. Strong test coverage: all 27 route handlers have co-located tests, contract suites for every adapter, config-drift guard test.

The issues are real but contained: a handful of **Medium** logic/security gaps and a batch of **Low** polish items. The fix list is headed by the admin re-promotion, answer-cache guardrail gap, ingest hash-recheck race, and the reranker threshold bug — each a small, surgical change.

### Severity summary

| Severity | Count | Areas |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 12 | auth, chat guardrails, ingest, search, API routes, domain |
| Low | ~25 | UI state, config, resilience, ops, ports |
| Info | ~20 | hygiene, docs, minor drift hazards |

---

## Top findings (cross-cutting, prioritized)

1. **[Medium] Demoted admins are silently re-promoted on their next request.**
   `packages/infrastructure/src/auth/clerk-adapter.ts:95` — `getAppSession()` auto-promotes any user with a verified email in `ADMIN_EMAILS` and writes `role: 'admin'` back to Clerk publicMetadata. An admin demoted via `setUserRole` (which carefully guards self-demotion and last-admin) regains admin on the very next request as long as the email stays in `ADMIN_EMAILS`. Demotion is ineffective; only an env change + redeploy truly revokes.
   **Fix:** durable demotion (explicit role-override flag consulted before auto-promotion) or require env removal before demoting.

2. **[Medium] Ungrounded (zero-citation) answers skip grading yet get cached and replayed.**
   `packages/application/src/chat/chat-turn.ts:544` (check) / `:475` (cache write) — `runHallucinationCheck` only grades when citations exist; a model answer with no `searchDocumentation` call passes all guardrails, is written to the answer cache, and replayed verbatim on future first turns. An ungrounded answer becomes a persistent cached "fact".
   **Fix:** treat zero-retrieval answers as uncacheable (or run an out-of-domain check) before `answerCache.set`.

3. **[Medium] Stale-index race in async ingest worker.**
   `src/composition.ts:112` — `ingestQueuedDocumentStandalone` verifies `fileHash` *before* the slow parse/embed phase, but the final transaction writes prepared rows and sets status `done` with no re-verification. A replace-upload landing mid-ingest lets the stale job overwrite the new upload's chunks and mark the row `done`; the fresh job then short-circuits. Row says hash v3, index contains v2, permanently.
   **Fix:** re-check hash inside the final transaction (or `UPDATE ... WHERE file_hash = expected`); carry the claimed hash out of `prepareIngest`.

4. **[Medium] Reranker silently discards lexical-only candidates (hybrid → vector-only).**
   `packages/application/src/rag/search.ts:169` — with a reranker configured, rows are fused via RRF then filtered by cosine `SIMILARITY_THRESHOLD` (0.5). Lexical-only rows carry Postgres `ts_rank` (`packages/infrastructure/src/db/lexical-search.ts:40`), which almost never reaches 0.5 — every lexical-only chunk is dropped. Hybrid retrieval degenerates whenever `rerankerProvider` is `local`/`cohere`.
   **Fix:** apply the cosine threshold only to vector-retrieved rows, or ts_rank-aware rescaling.

5. **[Medium] Chat pipeline is forked in the production route behind an env flag.**
   `src/app/api/chat/route.ts` (~688 lines) contains a full copy of the pipeline (tools, cache, hallucination check, metrics); the tested use-case only runs when `CHAT_TURN_USE_CASE=1` (`src/app/api/chat/route.ts:678`). The main chat-turn test suite exercises the non-default path; a parity test exists but compares narrow scenarios. Two copies of guardrail/caching/rate-limit logic will inevitably diverge — the one place clean-architecture layering isn't actually in effect.
   **Fix:** finish the migration to `chatTurn` and delete the fork.

6. **[Medium] 100 MB PDF upload cap vs 50 MB blob `put` cap — the 50–100 MB range always fails.**
   `packages/domain/src/constants.ts:6` sets `UPLOAD_CHUNKED_MAX_PDF_BYTES = 100_000_000`; every storage adapter caps `put` at `BLOB_GET_MAX_BYTES = 50_000_000` (`packages/infrastructure/src/storage/blob-storage-fs.ts:40`, `blob-storage-s3-family.ts:105`). A 60 MB PDF passes route validation then always fails with `PayloadTooLargeError` at `blobStorage.put`.
   **Fix:** raise the put cap (or introduce a separate `BLOB_PUT_MAX_BYTES`) to ≥ the upload cap. Server-action `bodySizeLimit` (100mb) corroborates the intended cap.

7. **[Medium] Chat POST re-throws errors instead of returning the safe envelope.**
   `src/app/api/chat/route.ts:674` — `catch (error) { logger.error(...); throw error; }` lets Next's default handling respond, inconsistent with every other route's `respond()` translation; can return generic 500s outside the app's safe-error envelope.
   **Fix:** return `respond(error)` like the rest of the API.

8. **[Medium] Chat "Try again" duplicates the user message.**
   `src/components/ChatInterface.tsx:582` — retry calls `submit(lastUserText)`, generating a new user part; the AI SDK appends the passed message before requesting while the original bubble remains after a failed stream → duplicate user message on every error-retry.
   **Fix:** retry with argless `sendMessage()` (resend last message).

9. **[Medium] Domain logger can throw inside error paths.**
   `packages/domain/src/logger.ts:56` — `JSON.stringify(entry)` with no circular guard (reproduced: throws `TypeError`), and unbounded `cause` recursion in `serializeError` (`:43`, throws `RangeError` on circular cause chains). Logging lives in catch paths, so this can convert a handled error into a crash.
   **Fix:** try/catch around serialization or a seen-set replacer; cap cause depth.

10. **[Medium] `deepPartial` is a Zod-internals walker with zero test coverage.**
    `packages/domain/src/app-config.ts:110` — pokes `_def.type/shape/innerType/element` (works on installed zod 4.4.3, verified). A Zod upgrade renaming a `_def` field would make `z.object({})` silently strip every key — settings patches become no-ops with no error.
    **Fix:** add direct unit tests; pin/verify against zod upgrades in CI.

11. **[Medium] `uploadPdfSync` parses/embeds inside a locked transaction.**
    `packages/application/src/admin/documents.ts:189` — long-held row lock + Neon transaction pressure during slow work; `replacePdf` already demonstrates the correct pattern.
    **Fix:** move parse/embed outside the transaction.

12. **[Medium] `reingestAll` causes corpus-wide search blackout + 3 sequential round-trips per doc.**
    `packages/application/src/admin/reingest.ts:48` — for each doc: update → enqueue → delete chunks, serially; chunks are dropped before the worker re-inserts, so every affected document has zero searchable chunks while the queue drains (minutes for large corpora).
    **Fix:** let the worker own chunk deletion (it already deletes-and-reinserts) or batch/chunk the sweep with concurrency.

---

## Package: `packages/domain`

**Security**

- **[Medium]** `sanitize-text.ts:3` — C1 control chars (U+0080–U+009F) not stripped: the regex covers `\x00-\x1F` and `\x7F` only. U+0085 NEL and U+009B CSI survive (reproduced). Impact bounded (React auto-escaping; no `dangerouslySetInnerHTML` anywhere in `src/`), but the security-relevant normalizer is incomplete.
  **Fix:** extend strip range through `\x9F` (or strip `\p{Cc}` minus `\t\n\r`).
- **[Low]** `sanitize-text.ts:1` — unpaired surrogates (`\p{Cs}`), private-use chars (`\p{Co}`) pass through; lone `U+D800` can mangle to U+FFFD at UTF-8 boundaries. Also `U+1680` is the only Unicode space not normalized (unlike its siblings on line 6), and lone `\r` survives (`:4`, only `\r\n` pairs normalized) — inconsistent newline model for downstream line-splitting.
  **Fix:** add `\p{Cs}\p{Co}` to strip, `\u1680` to spaces, map `/\r(?!\n)/g` → `\n`.
- **[Low]** `app-config.ts:22` — `customInstructions` is `z.string().optional()` with no max length, injected verbatim into the system prompt, and the admin settings PUT route parses `req.json()` with no body-size cap (Next's `bodySizeLimit` covers server actions only). Admin-only, but enables multi-MB prompt bloat on every chat turn.
  **Fix:** add `.max(...)`.
- **[Info]** `sanitizeText`'s actual role is data hygiene, not injection defense (consumers: `src/app/api/chat/route.ts:281`, `packages/application/src/chat/chat-turn.ts:302`, `src/app/(app)/admin/actions.ts:205`, `src/app/api/admin/tickets/[ticketId]/route.ts:38`). The name invites misuse; document it.

**Architecture / design**

- **[Medium]** `.dependency-cruiser.cjs:8` — "domain may only depend on zod" is not enforced: the rule only blocks a fixed `BANNED_PACKAGES` list; any other npm package would pass. Purity holds today only because pnpm limits domain's deps to `zod` (verified).
  **Fix:** invert to an allow-list (flag any `npm` dependency in domain that is not `zod`).
- **[Low]** `ports.ts:586` — Node `Buffer` hardcoded in `BlobStorage.put/get`, `PdfParser.extractText`, `Hasher.sha256` despite the package's runtime-neutral intent (`ContentParser` documents `Uint8Array`); the type resolves ambiently via root `@types/node`.
  **Fix:** accept `Uint8Array` consistently.
- **[Low]** `ports.ts:642` — `SettingsRepo.saveOverrides` returns an untagged union (`{ version: number } | { conflict: true }`) forcing `'conflict' in result` checks (`src/app/api/admin/settings/route.ts:105`) while the package ships `Result<T,E>` for exactly this.
- **[Low]** `ports.ts:87` — `parseChunkedMarkdown` delimiter default undocumented and triplicated (port / impl hardcode `MD_CHUNK_DELIMITER` / env override via `packages/infrastructure/src/config/env.ts:52` silently ignored when callers omit `delimiter`).
- **[Info]** `ports.ts:353` vs `app-config.ts:87` — two vocabularies for retrieval mode (`'agentic' | 'vector'` vs `'agentic' | 'normal'`), bridged explicitly at `packages/application/src/chat/chat-turn.ts:361`. Invite drift.

**Code quality**

- **[Medium]** `app-config.ts:110` — `deepPartial` walker untested (see Top finding 10).
- **[Low]** `ports.ts:191` — `ChunkRepository` redeclares ~35 inherited signatures verbatim that can silently drift from `VectorSearch`/`LexicalSearch`/`ChunkStore`; `extends` already provides them.
- **[Low]** `logger.ts:22` — over-broad redaction `/\b[A-Za-z0-9_-]{32,}\b/g` redacts hashes/IDs too; combine with circular-crash findings and logs become lossy *and* fragile.
- **[Info]** `errors.ts` — inconsistent `cause` support: only `ExternalServiceError` (`:71`) and `ParseError` (`:81`) accept `ErrorOptions`; the other seven subclasses drop it. Hierarchy itself is sound and correctly consumed by `src/lib/http.ts:74`.
- **[Low]** `constants.ts:11` — empty string as "unset" sentinel for `CCH_MODEL`/`GRADE_MODEL`; works only because consumers guard with `||`. Use `undefined` semantics or document the contract.

## Package: `packages/application`

**Bugs & logic**

- **[Medium]** Reranker + hybrid threshold (Top finding 4), plus no test exercises this interaction (`packages/application/src/chat/__tests__/` / `rag` search tests stop short of the reranker path).
- **[Medium]** Upload/reingest issues (Top findings 11–12).
- **[Low]** `chat/chat-turn.ts:280` — `ticketOpenedInTurn` flag set *before* the ticket rate-limit check; if limited, LLM retries see "ticket already created" — a false statement hiding the real retry window. Set the flag only after `createTicket` succeeds.
- **[Low]** `rag/ingest-prechunked.ts:145` — pre-chunked ingest doesn't map PG `23505` (unique name) to `ConflictError` the way `rag/ingest.ts:313` does; concurrent same-name uploads surface as 502-class instead of retryable 409.
- **[Info]** `rag/search.ts:153` — window mode emits fully-subsumed citations with empty snippets (deliberate token dedup, but shown to users); decide whether to drop them.

**Security**

- **[Medium]** Guardrail/cache gap (Top finding 2).
- **[Low]** Defense-in-depth gap: `listUsers` (`auth/users.ts:9` — returns full emails), `getDocumentById` (`admin/documents.ts:334`), `recountChunks*` (`:461`, `:469`) lack `requireAdminActor` while every sibling use-case has it. Not exploitable today (all call sites gate at the boundary) but a future caller would leak PII.
- **[Low]** `prompt/build-system-prompt.ts:90` — chunk `source`/content interpolated unescaped into `<reference source="...">` framing in both prefetched prompt blocks and tool results (`chat/chat-turn.ts:236`); a crafted `source:` meta line in an uploaded doc can break out of the framing. Mitigations exist (admin-only uploads, untrusted-content directive, client roles restricted to user/assistant, `sanitizeText`), keeping this Low. **Fix:** escape/strip `<`, `>`, quotes in the attribute.
- **[Info]** `chat/feedback.ts:14` — any signed-in user can attach up to 50 arbitrary document/chunk ids to their own turn's feedback (not validated against the turn).

**Performance**

- See Top findings 11–12; analytics full-scan notes are under infrastructure.

**Error handling**

- **[Low]** `admin/tickets.ts:155` — `createTicket` retries *any* insert failure 5×; the retry exists for `TKT-xxxxxxxx` collisions but a downed DB causes 5 identical failures before surfacing. Retry only on unique-violation.
- **[Info]** `chat/chat-turn.ts:493` — mid-stream failures never record the turn in `chatEvents` → analytics undercount failed/aborted turns. Client-facing message is honestly generic.

**Architecture**

- **[Medium]** Forked chat route behind `CHAT_TURN_USE_CASE` (Top finding 5).
- **[Info]** Otherwise exemplary: `@app/application` imports only `@app/domain`, `ai`/`zod` types, `node:crypto` — zero infra/next/react imports (verified by import scan); single non-type cast sits behind full zod validation.
- **[Info]** Minor duplication: `isDocumentNameConflict` (`rag/ingest.ts:26` + `admin/documents.ts:33`); `safeBlobName`/`newBlobKey` (`rag/ingest-prechunked.ts:18` + `admin/documents.ts:39`).

## Package: `packages/infrastructure` — foundation (db / auth / config / core)

**Security**

- **[Medium]** Admin re-promotion (Top finding 1). Related: `clerk-adapter.ts:56` — `ROLE_TTL_MS = 30_000` role cache gives a ~30s stale-accept window after demotion; `syncClerkUserRole` invalidates only the current process's cache, other instances serve stale `admin` until TTL. Document the window or shorten TTL for demotions.
- **[Low]** `auth/clerk-adapter.ts:174` — role fallback trusts `sessionClaims.metadata.role` for users with no local row. Clerk-signed and server-writable, so not forgeable — but it extends the admin-grant trust boundary to whatever populates publicMetadata. Drop or document.
- **[Low]** `auth/clerk-shared.ts:89` — `getClerkUserCached(userId)` ignores its argument: caches `currentUser()` under whatever id the caller passes. Safe today (only called with the authenticated user's own id) but the signature invites cross-user cache poisoning. Assert/derive the id or rename.
- **[Info]** No Clerk webhook endpoint exists — user sync is session-driven, so webhook signature verification is N/A. The four middleware-exempt admin routes each enforce real gates: QStash signature + `iat` replay window + signature dedup (`src/app/api/admin/ingest-worker/route.ts:35`), `timingSafeEqual` CRON_SECRET (`src/app/api/admin/queue/sweep/route.ts:16`, analytics/rollup), plus same-origin CSRF in `requireAdminRoute` (`src/composition.ts:372`) and Clerk `auth.protect()` in middleware. Trust boundaries hold.
- **[Info]** No SQL injection found: every raw query uses parameterized Drizzle `sql` templates; vector literals validated as finite arrays (`db/vector-search.ts:27`); LIKE patterns escaped (`db/repositories.ts:42`); a unit test asserts the parameterized `IN` shape (`db/__tests__/repositories.test.ts:37`).

**Bugs & logic**

- **[Low]** `db/repositories.ts:116` — `insertDocument` resurrect path (soft-deleted re-upload) takes no row lock: check → delete chunks → update is only retried on 23505; two concurrent resurrects could interleave chunk deletes. Both production callers hold `FOR UPDATE` first, so latent. **Fix:** lock inside `tryInsert` or document the precondition.
- **[Low]** `db/vector-search.ts:36` — filtered vector search takes top `max(limit*10, 50)` matches *globally* then filters by `documentId`; can under-return. Push the predicate into the candidate CTE.
- **[Info]** `db/chat-feedback-repo.ts:47` — feedback upsert allowed on chat events with `user_id IS NULL`; low impact.

**Performance**

- **[Low]** `db/pool.ts:4` — pool `max` hardcoded 20 per serverless instance, not env-tunable; many concurrent Vercel instances can exhaust Neon limits. Timeouts (10s) are reasonable.
- **[Low]** `db/chat-events-repo.ts:329` — `getDocumentUtility` laterally expands `meta->'documentIds'` over all rows with no containment predicate, so the GIN index (migration 0014) can't help; `getTurnsToTicket` (`:381`) runs three window passes over the whole table without a range. Admin-only, tolerable now, grows linearly.
- **[Info]** Hot paths are well indexed and bounded (clamped list limits, unique `turn_id`, composite `(document_id, chunk_index)`, partial unique `file_name`). pgvector `<=>` operator matches the HNSW `vector_cosine_ops` partial index whose WHERE clause matches the query predicate (`db/schema.ts:44`, migration 0005).

**Error handling / GDPR**

- **[Low]** `db/chat-events-repo.ts:470` — `purgeUserData`/`anonymizeUserData` never scrub `audit_dead_letter`, which stores whole chat-event batches (query text + user ids) dead-lettered by `persist()` (`:143`). GDPR gap.
- **[Info]** No DB error leakage: non-`DomainError` → generic `internal_error` body (`src/lib/http.ts:78`); `isNeonUrl` redacts passwords from invalid-URL errors (`db/pool.ts:10`).

**Architecture**

- **[Info]** All 17 migrations checked against `schema.ts`: consistent (timestamptz conversion 0017, partial unique 0006, HNSW rebuild 0005, tsvector generated column 0004, matview v2/UTC 0013/0016, feedback FK cascade 0015).
- **[Info]** Module-load side effects: `db` created at import (`db/client.ts:28`); `VECTOR_DIM` resolves at import of `schema-vector.ts:18` (deprecated but still used by `vector-search.ts:3`, `chunk-store.ts:3`) — invalid `EMBEDDING_DIMENSION` crashes DB-less tooling. Documented fail-fast.
- **[Info]** Minor type-laundering: node-postgres drizzle cast to `NeonDatabase` (`db/client.ts:25`); pervasive `as unknown as { rows }` casts on raw `execute` results.

**Tests**

- **[Info]** db suite (~1,900 lines) is strong: SQL-shape assertions for parameterization + integration suite that skips gracefully without `DATABASE_URL`. Gaps: no test for concurrent `insertDocument` resurrect, no test for the `getAppSession` promotion branch.

## Package: `packages/infrastructure` — adapters (llm / chunking / pdf / markdown / queue / storage)

**Bugs & logic**

- **[Medium]** Upload-cap vs blob-cap mismatch (Top finding 6).
- **[Low]** `llm/ollama-chat-service.ts:7` / `llm/ollama-embedding-service.ts:14` — Ollama base URL builds `${baseURL}/v1` unconditionally; an `OLLAMA_BASE_URL` ending in `/v1` (common copy-paste) 404s every request at `/v1/v1`. The `openai` provider already normalizes (`llm/openai-base-url.ts:68`) — reuse it.
- **[Low]** `config/env.ts:55` — `INGEST_CHUNK_OVERLAP` documented as overridable (`pdf/langchain-splitter.ts:122`) but silently derived as `floor(chunkSize/10)`. Read the var or correct the docs.
- **[Low]** `markdown/md-parser.ts:89` — fence closer matches on first char only; a 4-backtick block is wrongly closed by a 3-backtick line (CommonMark requires ≥ opener length), so a chunk delimiter inside the fence splits the segment.
- **[Low]** `config/env.ts:32` — non-positive `INGEST_CHUNK_SIZE` passes `finiteOrDefault` and blows up mid-ingest instead of at boot. Add a `> 0` check like `resolveVectorDim` (`db/schema-vector.ts:8`).
- **[Info]** `llm/ollama-chat-service.ts:8` — default model `gemma4:e2b` may not exist on the Ollama registry (known tag is `gemma3n:e2b`); verify and pin a real tag (mirrored in `.env.example:47`).

**Security**

- **[Low]** `llm/graders.ts:122` / `:150` — grader prompts interpolate raw uploaded-document text between `BEGIN DOCUMENT`/`END DOCUMENTS` markers with no untrusted-data framing; a hostile document can emit the markers and steer verdicts (e.g., force the hallucination grader to `yes`, letting an ungrounded answer pass the safety gate). Contrast: `llm/doc-summarizer.ts:33` does frame text as untrusted. Apply the same framing (consider canary markers).
- **[Info]** No SSRF: model/Ollama endpoints come only from server env; `AppConfig` (admin-overridable) contains no URLs; nothing user-controllable reaches `createOpenAI`/`fetch`. No API keys in errors or logs anywhere in the slice.
- **[Info]** FS blob storage path traversal properly blocked (`storage/blob-storage-fs.ts:10`, prefix check + tests). Edge: key resolving to `baseDir` itself yields raw `EISDIR` instead of `NotFoundError` (robustness nit).
- **[Info]** Queue deserialization safe: worker verifies QStash signatures, replay window + signature dedup, 1MB body cap, integer `documentId` (`src/app/api/admin/ingest-worker/route.ts:34`).

**Performance / resilience**

- **[Low]** No request timeout on any provider LLM call (`llm/ollama-chat-service.ts:5`, `openai-chat-service.ts:18`, `google-chat-service.ts:9`, `google-embedding-service.ts:10`); hung provider rides undici's ~300s default × 5 retries → ~25 min worker stall; graders run inside chat turns. Cohere already shows the pattern (`llm/cohere-reranker.ts:50` — `AbortSignal.timeout`). Wire `abortSignal`/timeouts into all `generateText`/`embed*` calls.
- **[Low]** `llm/google-embedding-service.ts:31` / `llm/openai-embedding-service.ts:76` — single `embed()` skips the 5-attempt retry that `embedBatch()` gets via `llm/embedding-batch-helper.ts:60`; a lone 429 fails the whole chat-turn query embedding. Ollama's route through the batch helper already (`ollama-embedding-service.ts:34`).
- **[Info]** `llm/openai-embedding-service.ts:67` — `Number(...) || 768` silently coerces garbage dim to default instead of failing like `resolveVectorDim`; `llm/ollama-embedding-service.ts:21` throws bare `Error` instead of `DomainError`.
- **[Info]** `llm/local-reranker.ts:84` — `scores[index] ?? 0` silently scores missing logits at `sigmoid(0)=0.5` instead of erroring (bounded: candidate pool capped at 30).
- **[Info]** PDF parser is hardened: byte/page/char budgets, pixel-gated `maxImageSize`, `isEvalSupported: false`, `disableAutoFetch`, `pdf.destroy()` in `finally` (`pdf/unpdf-parser.ts:13`), dedicated limit tests. Near the cap, full text is materialized ~3× — consider streaming join or lower default cap.
- **[Info]** No lost jobs: QStash publish wraps errors with document context (`queue/qstash-queue.ts:92`); double-processing prevented by `claimIngest`; drops after retry exhaustion reclaimed by queued sweeper → `failed` (`queue/queued-sweeper.ts:126`, wired in `src/composition.ts:282`).

**Architecture / tests**

- **[Info]** Adapters honor port contracts behind shared registry factories (`infrastructure/src/registry.ts:8`) with self-registration; swappability is real (local↔cloud storage, sync↔QStash queue, env-driven, fail-closed prod defaults — `storage/blob-storage-factory.ts:72`).
- **[Info]** Reranker availability dual source of truth: env snapshot at module load (`llm/index.ts:73`) vs call-time re-read; reconciled via `updateRerankerAvailability` (`src/composition.ts:359`). Works, but a trap for future edits.
- **[Info]** Contract suites exist for every adapter and are fully mocked (233 tests passing at review time). Gap: nothing asserts the upload-cap-vs-blob-cap interplay (cross-package concern).

## `src/` — server shell (API routes, proxy, composition, lib)

**Security**

- **[Medium]** Role-cache stale window (see infrastructure foundation).
- **[Low]** `src/composition.ts:365` — CSRF guard `assertSameOrigin` is a no-op when `Origin` is absent (non-browser clients, curl, privacy proxies): all mutating routes skip the check, protection rests on Clerk cookie + SameSite alone. For cookie-authenticated browser sessions, require `Origin` (or a custom anti-CSRF header like `X-Requested-With`) instead of treating absence as pass.
- **[Low]** `src/app/api/admin/documents/[id]/download/route.ts:14` (+ `blob/route.ts:13`) — for signed-URL providers, `Content-Disposition` is set on the 302 redirect response, not the object; browsers don't apply redirect-response headers to the fetched object, so downloads may render inline. Set `response-content-disposition`/`response-content-type` on the signed URL itself.
- **[Low]** QStash replay dedupe uses a per-process signature Map (`src/app/api/admin/ingest-worker/route.ts:9`); not globally effective across serverless instances. Bounded by idempotent `claimIngest` + hash checks — acceptable, but true exactly-once needs shared dedupe.
- **[Info]** No findings for: admin role verification (all ~20 admin routes call `requireAdmin*` — verified), IDOR (numeric-validated, admin-only), path traversal, stack-trace leakage (`SAFE_MESSAGES` in `src/lib/http.ts:8`), body-size limits, GDPR self-purge protection (`src/app/api/admin/users/[clerkId]/gdpr/route.ts:20`).

**Bugs / error handling**

- **[Medium]** Chat route re-throw (Top finding 7).
- **[Low]** `src/app/api/admin/queue/sweep/route.ts:27` (+ `analytics/rollup/route.ts:27`) — bad/missing CRON_SECRET returns 405 Method Not Allowed instead of 401/403.
- **[Low]** `src/app/api/chat/feedback/route.ts:39` — after `readBoundedText` caps bytes, code re-checks via `JSON.stringify(raw).length`, which can disagree with original byte length (escaping/unicode) → inconsistent 413 behavior. Rely on the bounded reader alone.
- **[Low]** `src/composition.ts:340` — `requireAdminRoute` maps *any* non-auth error (e.g., transient DB failure) to 503; distinguish backend failures (500/502) from overload.
- **[Info]** `reingestInFlight` is a module-level boolean, not shared across instances (duplicate re-ingest runs possible under manual double-trigger).

**Architecture**

- **[Info]** `src/` is genuinely a thin shell; `src/lib` is almost entirely re-exports. Two exceptions where real logic lives in the shell: `src/app/api/admin/settings/descriptor.ts` (204 lines of schema-introspection/merge/flatten — arguably application concern) and `src/lib/config/runtime.ts` (TTL runtime-config cache + env-lock merge). Move into packages if the boundary is meant strict.
- **[Info]** No duplicated logic between `src/lib` and `packages/` (re-export pattern keeps single source of truth).

**Tests**

- **[Info]** Excellent: all 27 route handlers have co-located `route.test.ts`, plus `proxy.test.ts`, `composition.test.ts`, `actions.test.ts`. Proxy test asserts auth behavior + matcher regex.
- **[Low]** `src/proxy.test.ts:63` — the test `vi.mock`s the auth adapter and re-implements the middleware policy inside the test, then tests that copy — drift risk vs `clerk-adapter.test.ts`. Reduce to matcher-config + delegation assertions.

## `src/` — UI / client

**Security (all clean)**

- **[Info]** No XSS vectors: zero `dangerouslySetInnerHTML`/`innerHTML`; AI markdown via `react-markdown` + `remark-gfm` **without** `rehype-raw` (`src/components/ChatInterface.tsx:210`); `SafeLink` allowlists `http(s)://` hrefs and downgrades everything else (incl. `javascript:`) to a `<span>`, `rel="noopener noreferrer"` (`:154`); citation fields render as text nodes; CSP `img-src` blocks markdown image-exfil beacons.
- **[Info]** No secrets in client bundles: only `NEXT_PUBLIC_` reads are in server files; client components fetch relative endpoints only; `ChatInterface` imports from `@/composition` as `import type` (erased).
- **[Info]** No open redirects: Clerk components validate redirect URLs server-side; sign-out hardcodes `redirectUrl: '/'` (`src/components/app/AppSidebar.tsx:132`).

**Bugs**

- **[Medium]** Retry duplicates user message (Top finding 8).
- **[Low]** `src/components/ChatInterface.tsx:329` — `pendingTurnIdRef` entries leak on abort/error/disconnect (`onFinish` early-returns without deleting); Map grows per failed turn for the session.
- **[Low]** `src/app/(app)/admin/settings/settings-client.tsx:1105` — policy editor inputs write live settings state on every keystroke; Cancel and Save buttons are identical (`:1132`/`:1135`), so "Cancel" commits edits into the unsaved-changes diff. Buffer in local Sheet state; commit on Save.
- **[Low]** `settings-client.tsx:220` — `res.json().catch(() => ({}))` then `setVersion(data.version as number)` can adopt `undefined` version on malformed responses; next save sends `expectedVersion: undefined` (same at conflict path `:229`). Validate before adopting.
- **[Low]** `src/components/admin/AuditLogTable.tsx:39` — audit `changes` JSON blindly cast to `SettingsChange[]` and fed to `SettingsRevertButton` (`src/components/admin/settings-revert-button.tsx:25`), which builds a PUT patch from stored `old` values; a malformed row reverts nonsense. Validate entries first.
- **[Low]** `src/app/(app)/admin/documents/upload-document-dialog.tsx:33` — toast effects keyed on `[state.error]` won't re-fire for an identical error string on a second failure. Key on a counter/submission id.
- **[Info]** `src/app/(app)/admin/error.tsx` drops `error.digest`, unlike chat/global error pages — inconsistent traceability.

**Performance**

- **[Low]** `src/components/ChatInterface.tsx:405` — `submitFeedback` depends on `[votes]`; every vote recreates `handleVote`, defeating `memo` on all `MessageItem`s. Use functional `setVotes`.
- **[Info]** No message-list virtualization (`:519`) and `buildSystemPrompt` recomputed per keystroke in settings preview (`settings-client.tsx:150`) — acceptable at expected scale. Client bundles deliberate (`ogl` confined to marketing page, hand-rolled SVG charts).

**Accessibility**

- **[Low]** `src/components/ChatInterface.tsx:479` — `aria-live="polite"` wraps the entire chat transcript; screen readers announce per-token streaming for the whole scroll region. Limit the live region to a small status node.
- **[Info]** Otherwise genuinely good: labeled icon buttons with `aria-pressed`, sr-only labels on filters, charts with `aria-label` + sr-only data lists (`src/components/admin/Charts.tsx:37`), IME-safe Enter handling (`:420`).

**Architecture / quality**

- **[Info]** Clean server/client split: server components fetch + gate (`src/app/(app)/admin/layout.tsx:8`), client components thin. The "reset derived state on prop change" pattern repeats in 4 components (`TicketDrawer`, `AuditFilterForm`, `TicketsFilterForm`, `AppSidebar`) — a shared `useSyncedState` hook would remove the copies.
- **[Info]** No `any` in UI code. Test gaps: no component tests for `TicketDrawer`, `UploadDocumentDialog`, `AppSidebar`, `IngestStatusPoller` (chat flow itself is well covered — 24 tests incl. a late-failed-stream turn-binding regression at `ChatInterface.test.tsx:508`).

## Ops / CI / config

- **[Info]** CI is strong: all Actions pinned by SHA with version comments, `permissions: contents: read`, frozen lockfile, pnpm store caching, drizzle journal check, migration role split (`MIGRATION_DATABASE_URL` least-privilege comment), deploy gated behind `production` environment approval. Eval workflow serializes per ref and auto-files/closes a failure issue.
- **[Low]** `docker-compose.yml` — `ollama/ollama` image unpinned (implicit `latest`) while the pgvector image is digest-pinned; reproducibility/supply-chain inconsistency.
- **[Info]** CSP in `next.config.ts` is tight (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, HSTS preload, no wildcard server-action origins). Two trade-offs worth a deliberate decision:
  - `script-src 'unsafe-inline'` (required for Clerk/Next inline scripts) — consider nonces/strict-dynamic later.
  - `connect-src` allows `https://api.openai.com` and `https://generativelanguage.googleapis.com` even though all LLM calls are server-side; broader than necessary (slightly enlarges exfil surface if an XSS ever exists).
- **[Info]** Dockerfile: non-root runtime user, healthcheck, standalone output, `.dockerignore` keeps `.env*` out of the image. `.gitignore` covers `.env*` (whitelisting only `.env.example`), `.blobs/`, `/documents/`.
- **[Info]** `vercel.json` crons hit the two CRON_SECRET-protected endpoints — consistent with the route checks.

---

## Cross-cutting strengths (keep doing these)

- **Auth defense-in-depth:** proxy gating *plus* per-route `requireAdmin*`, QStash signature + replay-window + dedup, `timingSafeEqual` cron secrets, same-origin CSRF, last-admin/self-demotion guards, 30s-bounded role cache.
- **Concurrency engineering:** atomic `claimIngest` (`queued→ingesting`), `FOR UPDATE` in upload paths, `nameStillClaimed` optimistic post-write check, race-safe settings seeding, dead-letter + drop-counters for metrics writes.
- **Error honesty at the boundary:** every `DomainError` mapped to a safe allowlisted message; unknown errors masked as generic 500; passwords redacted from connection errors.
- **Fail-closed adapters:** graders treat outages as `no`, blob factory refuses ambiguous prod config, sweeper converts stranded jobs to `failed`.
- **Testing culture:** route-level, contract-level, and drift-guard tests; integration suite skips gracefully without a DB.

## Recommended fix order

1. Admin re-promotion (auth correctness) — `clerk-adapter.ts:95`
2. Zero-citation cache gap (guardrail integrity) — `chat-turn.ts:544`/`:475`
3. Ingest hash re-check (data integrity) — `composition.ts:112`
4. Reranker/hybrid threshold (search quality) — `search.ts:169`
5. Chat route fork consolidation (architecture debt) — `api/chat/route.ts`
6. 50 MB vs 100 MB cap alignment (functional bug) — `constants.ts:4`
7. LLM provider timeouts (resilience) — `llm/*-service.ts`
8. Chat route re-throw → `respond()` (consistency) — `route.ts:674`
9. UI retry duplication (user-facing bug) — `ChatInterface.tsx:582`
10. Domain logger circular-safety + `deepPartial` tests (foundational hygiene)

*Report generated 2026-08-20. CLI package review deferred; run separately when needed.*
