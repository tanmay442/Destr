# How to Add a Model Adapter

Secret-free. This guide explains how to add a new chat-model provider adapter
without leaking vendor details into application code. Application code stays
provider-neutral: only `zod`, `@app/domain`, and application-relative imports
(`pnpm arch` enforces this via `scripts/architecture-policy.ts` —
`FORBIDDEN_VENDOR_PACKAGE_FAMILIES` bars `@ai-sdk/*`, vendor SDKs, and
`@app/infrastructure` from application and domain code). All vendor parsing
and vendor option keys live in infrastructure adapters.

## The application interface (what the app consumes)

The app never imports a vendor SDK. It consumes one neutral seam:

- `packages/application/src/agent/model-backend.ts` — the provider-neutral
  single-step model port (`AgentModelBackend`, `generateStep`). The loop in
  `packages/application/src/agent/support-agent.ts` owns step policy; the
  backend answers exactly one model step per call.
- `packages/infrastructure/src/llm/registries.ts` —
  `ChatModelProviderAdapter`: the per-provider metadata + behavior record.
- `packages/infrastructure/src/llm/model.ts` — `getChatModelAdapter` resolves
  the model together with its adapter, plus `getChatModelCapabilities`,
  `getChatModelToolCapabilities`, `getChatModelProviderOptions`,
  `getChatModelTelemetry`, `parseChatModelUsage` (`model.ts:92-131`).
- `packages/domain/src/tool-capabilities.ts` — `ProviderToolCapabilities` and
  the mode unions (the vocabulary both sides share).

`ChatModelProviderAdapter` (`registries.ts:28-35`) has exactly four members:

| Member | Purpose |
|---|---|
| `capabilities: PromptCacheCapabilities` | Prompt-cache facts: `strategy`, `automatic`, `explicit`, `telemetry` |
| `toolCapabilities?: ProviderToolCapabilities` | Tool behavior declaration (strict schemas, examples, output schemas, parallel calls, repair, approval hooks) |
| `buildProviderOptions?(context)` | Vendor option keys for a request (e.g. cache key); `undefined` means "leave the request untouched" |
| `parseUsage(usage, providerMetadata)` | Convert normalized AI SDK usage + provider metadata into `PromptCacheUsage` |

The seam functions are re-exported through
`packages/infrastructure/src/llm/index.ts:41-60` and surfaced to composition
as `Llm` (`packages/infrastructure/src/index.ts:2-18`); composition consumes
them at `src/composition.ts:572-599` (`getChatModelRequestOptions`,
`getModelToolCapabilities`) and the catalog consumes capabilities in
`packages/application/src/agent/tool-catalog.ts`.

## Tool capability declaration

Declare tool behavior with the `ProviderToolCapabilities` vocabulary from
`packages/domain/src/tool-capabilities.ts`:

- `strictSchemas`: `native` | `emulated` | `unsupported`
- `inputExamples`: `native` | `description_middleware` | `unsupported`
- `outputSchemas`: `native` | `validated_locally`
- `parallelCalls`: boolean
- `toolCallRepair`: `supported` | `unsupported`
- `approvalHooks`: `native` | `application`

Current declarations (copy the closest one as your starting point):

- `packages/infrastructure/src/llm/openai-chat-service.ts:33` — all native,
  `parallelCalls: true`.
- `packages/infrastructure/src/llm/google-chat-service.ts:29` — same, except
  `inputExamples: 'description_middleware'`.
- `packages/infrastructure/src/llm/ollama-chat-service.ts:18` —
  `strictSchemas: 'emulated'`, `inputExamples: 'unsupported'`,
  `parallelCalls: false` (local models get stricter treatment).

The catalog consumes these facts in
`packages/application/src/agent/tool-catalog.ts:114-133`: non-native examples
are folded into the description via `adaptDescriptionWithExamples`
(`packages/application/src/agent/model-tool-capabilities.ts:49-61`); native
examples are passed through as `{ input }` pairs; `strict` is `true` for
`native`, omitted for `unsupported`. Outputs are always validated locally
(`outputSchemas: 'validated_locally'` on every current adapter).

If you register a provider factory without an adapter,
`getChatModelAdapter` (`model.ts:62-90`) applies safe fallbacks (cache
capabilities `none`/all-false, the default tool capabilities at
`model.ts:44-51`). A missing factory for the configured `CHAT_PROVIDER`
throws (`model.ts:26-33`, via `resolveProvider`). Register both under the
same key so the adapter is found.

## Strict schemas, examples, output validation

Tools declare all three in the catalog definition; the adapter only declares
how the provider handles them:

- Input schema: the real zod validation schema lives on the tool definition
  (e.g. `searchDocumentationInputSchema` in
  `packages/application/src/agent/tools/search-documentation.ts:34-52`, with
  shipped `SEARCH_TOOL_EXAMPLES` at `:77-80`). The infrastructure tool
  envelope (`defineAgentModelTool` in
  `packages/infrastructure/src/llm/agent-backend.ts:15-35`) carries the real
  validation schema to the model but no `execute`, so the SDK returns tool
  calls without executing them; execution stays in the application catalog.
- `inputSchemaJson` on `AgentModelBackendTool` (`model-backend.ts:52-59`) is
  an opaque plain-JSON placeholder — never a zod object — so the validation
  library does not leak into adapters.
- Output schemas are validated locally by the application
  (`outputSchemas: 'validated_locally'`); no adapter claims native output
  validation today.

## Prompt-cache capability + telemetry

Capabilities are frozen facts in `packages/infrastructure/src/llm/prompt-cache.ts`:

- `OPENAI_PROMPT_CACHE_CAPABILITIES` — `automatic`, telemetry on.
- `GOOGLE_PROMPT_CACHE_CAPABILITIES` — `explicit`, telemetry on.
- `OLLAMA_PROMPT_CACHE_CAPABILITIES` — `none`, telemetry off.

Request behavior: `buildOpenAIPromptCacheOptions` derives a deterministic
`destr:{prefixVersion}:{sha256/32}` key from `{ stablePromptPrefix,
prefixVersion }` (`prefixCacheKey`, `prompt-cache.ts:197-202`);
`buildGooglePromptCacheOptions` only forwards a configured
`GOOGLE_CACHED_CONTENT` resource name and returns `undefined` otherwise
(leaving the request untouched). Ollama registers no `buildProviderOptions`.

Usage parsing (`parsePromptCacheUsage`, `prompt-cache.ts:147-195`): raw
provider usage is authoritative because some adapters normalize absent fields
to `0`. Absent cache metadata parses to `null` + `unsupported` — never a
zero. A reported zero is preserved as a real zero (pinned in
`prompt-cache.test.ts:71-90`).

The composition seam (`src/composition.ts:572-585`) attaches
`buildProviderOptions` output, `{ provider, model, promptPrefixVersion,
promptCache: capabilities }` telemetry, and the adapter `parseUsage` to every
turn; per-step tokens flow back through `toBackendStep`
(`agent-backend.ts:179-199`). When `AGENTIC_ENABLED=false`, aux models
resolve to `undefined` so graders/rewriters are absent
(`packages/infrastructure/src/llm/index.ts:159`); a new adapter inherits
that behavior automatically through `getAuxModels`.

## Usage parsing rules for a new adapter

1. Read raw provider fields first (`usage.raw`, `providerMetadata.<name>`);
   fall back to normalized fields only when raw is absent.
2. Every metric is `{ value, status }` with status `reported` | `unsupported`
   (`PromptCacheUsage`, `prompt-cache.ts:44-54`). Missing is `unsupported`,
   never zero-filled.
3. `cacheHitRatio` is `read / input` clamped to `[0, 1]`, `null` when either
   side is missing or input is zero.

Mirror these rules in tests. The required suites are:

- `packages/infrastructure/src/llm/prompt-cache.test.ts` — capability
  constants, deterministic option keys, zero-vs-absent parsing, ratio math.
- `packages/infrastructure/src/llm/__tests__/prompt-cache-capability-wp8.test.ts` —
  per-provider capability proof plus the adapter-to-billing contract: absent
  metadata is `missing`/`unsupported`, invalid numbers are `parse_error`,
  billing completeness is `complete` | `partial` | `unknown`, and nothing is
  ever zero-filled. Option syntax alone is never cache proof (a key without
  per-step telemetry bills `unknown`).

## Pricing completeness

`computeStepCost` takes explicit `TokenPriceRates` carrying a `priceVersion`
(`packages/application/src/agent/observability/usage-normalizer.ts:190-242`);
per-step cost telemetry records `billableMicros` with `costCompleteness`
`complete` | `partial` | `unknown`
(`packages/application/src/agent/observability/wp8-events.ts:693-703`).
Rate cards in tests are fixtures, not billing truth: keep unknown components
explicit (never zero) and replace fixture rates with versioned price
configuration at integration time.

## Cancellation and deadlines

Every `AgentModelBackend` implementation MUST honor both (`model-backend.ts:8-15`):

- Signal abortion (before or during the call) rejects with a `DOMException`
  named `AbortError`. The loop maps it to a `cancelled` stop.
- `timeoutMs` expiry rejects with an `Error` named `TimeoutError`. The loop
  maps it to a `timeout` stop.

Reference implementation: `createAgentModelBackend().generateStep`
(`agent-backend.ts:66-130`) pre-checks `signal.aborted` and `timeoutMs > 0`,
chains an `AbortController` with an `unref`'d timer, runs one step
(`stopWhen: stepCountIs(1)` at `:111`), re-checks abortion after settle, and
maps timeout-controller aborts to `TimeoutError`. Test both paths with
`createScriptedBackend` (`packages/application/src/agent/scripted-model.ts`,
which supports queued `abort` / `timeout` / `fail` steps).

## Contract and evaluation tests

A new adapter must also pass the shared gates — vendor surface goes through
contract tests, retrieval quality through the eval harness:

- Vendor contracts: `packages/infrastructure/src/llm/__tests__/contracts/`
  (`embedding-service-contract.ts`, `reranker-contract.ts`, plus the
  per-provider `*.contract.test.ts` files). If the vendor has an embedding
  or reranker surface, add contract tests here following the existing
  pattern; contract tests run against the real vendor shape, not mocks.
- Prompt-cache capability suite (above) — the adapter-to-billing contract.
- Eval harness (`scripts/eval/`): `pnpm eval` (mock OVERALL PASS),
  `pnpm eval:retrieval`, `pnpm eval:agent:mock`, `pnpm eval:agent:adversarial`,
  `pnpm eval:agent:cost`. Keyed real-model eval (`EVAL_REAL=1`) is a
  separately authorized gate that spends budget — never run it for adapter
  CI. Until real-model prompt-cache reuse/billing is verified (see
  `docs/known-limitations.md`), new adapters bill cache components as
  `unknown`, never zero.

## Checklist for a new adapter

1. Add `packages/infrastructure/src/llm/<name>-chat-service.ts`: factory +
   `registerChatProvider('<key>', …)` + `registerChatProviderAdapter('<key>',
   { capabilities, buildProviderOptions?, toolCapabilities, parseUsage })`.
   Keep the `<key>` identical in both calls and equal to the `CHAT_PROVIDER`
   value; provider option keys never leave this file.
2. Declare `toolCapabilities` using the `packages/domain/src/tool-capabilities.ts`
   vocabulary; when in doubt copy ollama (strictest) rather than openai.
3. Implement `parseUsage` via `parsePromptCacheUsage('<key>', …)` extended
   with the vendor's raw field paths; absent stays `unsupported`, never zero.
4. Add capability + options + usage tests mirroring `prompt-cache.test.ts`
   and the WP-8 capability suite (constants, key determinism, zero-vs-absent,
   billing completeness).
5. If the vendor has an embedding or reranker surface, add contract tests
   under `packages/infrastructure/src/llm/__tests__/contracts/` following
   `embedding-service-contract.ts` / `reranker-contract.ts`.
6. Verify the seams still resolve: `getChatModelAdapter`,
   `getChatModelToolCapabilities`, `getChatModelProviderOptions`,
   `parseChatModelUsage` (`model.ts:92-131`, re-exported from
   `packages/infrastructure/src/llm/index.ts:41-60` and surfaced as `Llm` from
   `packages/infrastructure/src/index.ts:2-18`), consumed in
   `src/composition.ts:572-599` and
   `packages/application/src/agent/tool-catalog.ts`.
7. Run the gates: `pnpm typecheck`, `pnpm lint`, `pnpm arch` (no new vendor
   import may appear outside infrastructure — see
   `scripts/architecture-policy.ts`), plus the focused suites above and
   `pnpm eval:agent:mock` as a regression check.
