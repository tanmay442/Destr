# WP-9 Migration Notes — Agentic Tooling / Search Cutover

Secret-free. WP-9 is complete in the working tree on branch
`codex/agentic-tooling-search-modernization`: the seven deleted flags, the
orchestrator wiring, and all test/eval migrations are done and green. The
structured orchestrator is the only agentic path, while normal hybrid
retrieval remains the default after the WP-4
`planner_rejected_keep_normal` decision. Every claim here was verified
against current code; corrections to the workstream brief are called out
inline.

## Removed names and their replacement path

| Removed | Replacement |
|---|---|
| `packages/application/src/rag/agentic-search.ts` (rewrite → hybrid/rerank retrieve → retry-once wrapper) + `export * from './agentic-search'` in `packages/application/src/rag/index.ts` | `runStructuredSearch` in `packages/application/src/agent/search/search-orchestrator.ts`, wired as `structuredSearch` in `src/composition.ts:503-525` and passed straight through in `src/app/api/chat/handler.ts` (conditional-spread probing removed) |
| `comp.agenticSearch` + `getAgenticDeps` in `src/composition.ts` (incl. the inline `AGENTIC_ENABLED=false` normal-direct fallback inside the wrapper) | `comp.structuredSearch` (always wired); the `AGENTIC_ENABLED=false` rollback now lives once in the turn seam (`turn.ts:337-343`) and runtime config (`src/lib/config/runtime.ts:142-153,219-234`) |
| `ChatTurnDeps.agenticSearch` / `CatalogCompatDeps.agenticSearch` / `AgenticSearchFn` (`turn-types.ts`, `turn-tools.ts`, `tools/search-documentation.ts`) | `ChatTurnDeps.structuredSearch` (`turn-types.ts:114-119`); the turn assembly derives `plannerActive = effectiveMode === 'agentic' && structuredSearch !== undefined` instead of reading planner flags |
| `isCatalogEnabled` + `TOOL_CATALOG_ENABLED` (deleted; assembly now lives in `agent/turn-tools.ts`) | Nothing — `buildCatalogToolsForTurn` is the only assembly; the catalog version recorded per turn is `tool-catalog-v1` |
| `buildChatTools` (legacy `chat-turn/chat-tools.ts` assembly) | Correction: already gone since WP-5 (`f23d89b` deleted the 576-line module); WP-9 changes nothing here |
| `SEARCH_STRUCTURED_PLANNER_ENABLED`, `SEARCH_PLANNER_SHADOW` (`search-flags.ts` deleted, barrel re-export removed from `search/index.ts`, `search-flags.test.ts` deleted) | Orchestrator selected by mode + wiring (see above); shadow comparison deleted from the request path (shadow budget bypass removed with it — every orchestrator call now consumes turn budgets) |
| `SEARCH_QUERY2DOC_ENABLED` (same deleted module) | Removed outright; no expansion path was ever wired (WP-4 read-and-ignored by design) |
| `SUPPORT_AGENT_ENABLED` (`agent/agent-flags.ts` deleted, barrel re-export removed from `agent/index.ts`) | `SupportAgent` loop always runs (`turn.ts:860-862`); the one-step no-tools fallback was deleted, not kept |
| `GROUNDED_RELEASE_ENABLED` (`agent/grounding/grounding-flags.ts` deleted, barrel re-export removed) | Release policy always runs fail-closed: deterministic validation, grader, verified-only release, safe response + no grounded-cache write for unverified answers |
| `WP8_ROUTE_DURATION_INCREASE_ENABLED` | Removed — `routeDurationIncrease` is deleted from `Wp8FlagName`/`WP8_FLAG_NAMES`/`readWp8Flags` (`packages/application/src/runtime/wp8-flags.ts`, now four flags) and the route stays pinned at `maxDuration = 60` (`src/app/api/chat/route.ts:13-26`); `docs/runtime/wp8-flags-rollback.md` was updated to match |
| Eval seams: `agenticSearch` live dep in `scripts/eval/run.ts`, stubs in `scripts/eval/agent-trajectory.ts`, the §C2 agentic-routing test in `scripts/eval/eval.test.ts`, `planner` mode in `scripts/eval/agent-retrieval-metrics.test.ts` | Correction: already migrated — single `searchChunks` dep in eval normal mode (`run.ts:177-188`, `agent-trajectory.ts:352`), §C2 now asserts the single-dep path (`eval.test.ts:607`), no `planner`/`agentic` mode remains in `agent-retrieval-metrics.test.ts`; structured comparison lives in `scripts/eval/wp4-retrieval.ts` |

Consistent (not stale): `docs/agent-tool-extension-guide.md` §2 is a
historical record stating the flag and legacy assembly "were deleted" — it
agrees with this cutover and needs no update.

## Behavioral notes for migrators

- First-turn prefetch is bypassed whenever the orchestrator serves the turn
  (`turn.ts:679-683`), so prefetch can never shadow orchestrated evidence.
- The turn-scoped tool assembly moved from `agent/compat/chat-tools-compat.ts`
  to `agent/turn-tools.ts` (pure move; `buildCatalogToolsForTurn` and its
  result shape are unchanged).
- Rollback after WP-9 is a revertible commit per removed flag; there is no
  runtime toggle back to the wrapper, the one-step agent fallback, fail-open
  grounding, or the planner experiment flags. Normal-direct retrieval is the
  default; `AGENTIC_ENABLED=false` is the supported production kill switch
  when an explicit agentic-mode override has been configured.

## COORDINATOR PATCH (resolved before commit — verified current)

1. Cache key versions (verified current; versions unchanged, field sets narrowed):
   `SYSTEM_PROMPT_VERSION = 4`, `SEARCH_RESULT_CONTRACT_VERSION = 2`
   (`packages/application/src/chat/cache-key.ts:3-4`),
   `TURN_FINGERPRINT_VERSION = 2`
   (`packages/application/src/chat/turn-fingerprint.ts:4`),
   `PROMPT_PREFIX_VERSION_TAG = 'prompt-prefix-v1'`
   (`packages/application/src/agent/prompt/prefix-version.ts:36`).
   The WP-9 diff removed the deleted agentic knobs
   (`agenticRetrieveLimit`, `agenticMaxRetries`,
   `agenticQueryRewriteEnabled`) from both `legacyCacheFingerprintFields`
   and `cacheFingerprintFields` (`cache-key.ts` diff) — versions stayed,
   so answer-cache entries keyed under the old field sets will miss, not
   collide; turn-result entries use the explicit WP-8 fingerprint bridge in
   item 3 below.
   Wire formats: coordination key `rag:turn-result:{user}:{turnId}` plus
   versioned key `rag:turn-result:v2:{user}:{turnId}` (`turn.ts:372-377`),
   `rag:answer:{sha256/32}` (`packages/infrastructure/src/auth/answer-cache-key.ts:37`),
   `rag:turn-slot:{user}:{slot}` (`src/admission.ts:56-57` — the slots
   module moved from `src/app/api/chat/slots.ts` to `src/admission.ts` in
   the admission-cutover workstream; key format unchanged).
2. Slots key migration: RESOLVED — no migration. Old and new paths use
   identical keys, count (2/user), and TTL (65 s) on the same coordination
   client; mixed-version instances interoperate and in-flight slots expire
   identically.
3. Fingerprint removal status: RESOLVED — `legacyTurnRequestFingerprint`
   deleted from `turn-fingerprint.ts` and its `turn.ts` import + hash field
   removed. `parseTurnResult` accepts the current `preResultContract` hashes
   and the exact WP-8 v2 hashes, which include the three controls removed by
   WP-9. The bridge hashes are treated as the same idempotent request, not as
   a broad mismatch bypass; every other v2 mismatch on the same turn id stays
   an idempotency conflict. New v2 and stable coordination records carry the
   WP-8-compatible hashes for the 24-hour turn-result TTL, so a rollback to
   WP-8 can read records written by WP-9 in the unchanged key namespace.
   The bridge preserves WP-8's configured retrieval mode separately from
   WP-9's new normal default, then resolves the removed controls in this order:
   persisted WP-8 settings captured as fingerprint-only compatibility metadata,
   legacy deployment env values (`AGENTIC_RETRIEVE_LIMIT`, `AGENTIC_MAX_RETRIES`, and the
   compatibility-only `AGENTIC_QUERY_REWRITE_ENABLED`), then the WP-8
   defaults (10, 1, enabled). These values are used only to reproduce hashes;
   they do not re-enable obsolete retrieval behavior or alter WP-9 answer
   cache keys.
   Pre-v2/unmarked entries remain transparent misses (recomputed; the
   verified-grounding check would reject them anyway), and verified grounding
   is still required before any turn-result replay. `legacySearchResultCacheFingerprint`
   remains the pre-result-contract hash for the current read-compat window.
4. `WP8_ROUTE_DURATION_INCREASE_ENABLED` code removal is done (see table);
   the `routeDurationIncrease` rows were deleted from
   `docs/runtime/wp8-flags-rollback.md` (flag table, rollback section, and
   wiring-status section) to match the code.
5. Test leftovers referencing removed seams: RESOLVED — `chat-turn.test.ts`
   migrated to `structuredOk`/`structuredError` factories (zero
   `agenticSearch` references), `src/__tests__/composition.test.ts:137`
   expects `structuredSearch`, eval seams migrated (see table correction
   above). Typecheck is clean; `test:agent` is green.
6. Residuals: RESOLVED — the unused `StructuredSearchFn.shadow` field was
   removed from `tools/search-documentation.ts`, and the
   `SUPPORT_AGENT_ENABLED` mention in the turn comment now points at the
   migration notes.
