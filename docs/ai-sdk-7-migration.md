# AI SDK 7 migration

WP-10 is the final phase of the agentic tooling/search modernization pull
request. It is intentionally isolated in its own signed commit so the SDK-major
upgrade can be reviewed, measured, and reverted independently from WP-0 through
WP-9.

## Version matrix

| Package | Before | WP-10 |
| --- | --- | --- |
| `ai` | `6.0.221` | `7.0.107` |
| `@ai-sdk/provider` | `3.0.13` | `4.0.17` |
| `@ai-sdk/react` | `3.0.223` | `4.0.110` |
| `@ai-sdk/openai` | `3.0.82` | `4.0.71` |
| `@ai-sdk/google` | `3.0.90` | `4.0.76` |

AI SDK 7 is ESM-only and requires Node.js 22 or newer. The root package now
declares both constraints; CI and container builds already use Node.js 22.
Both the root importer and `@app/infrastructure` declare the same SDK versions,
and `pnpm why @ai-sdk/provider` must resolve one provider-protocol version.

## Source changes

- Provider seams use the v4 language/embedding/provider-option protocol types.
- Core calls use `instructions`, `isStepCount`, and the explicit `finalStep`
  view so the application retains its single-provider-step contract despite
  AI SDK 7's aggregate top-level result fields.
- The Google adapter uses `createGoogle`; the deprecated
  `createGoogleGenerativeAI` alias is removed.
- Request-owned tool context uses the stable `context` name instead of the
  former experimental compatibility name.
- Prompt-cache accounting continues to read normalized v7
  `inputTokenDetails.cacheReadTokens`/`cacheWriteTokens`, while raw vendor
  metadata remains supported for accurate provider billing telemetry.
- `useChat` keeps its chat-specific `onFinish` callback. This is a current UI
  API, not the deprecated core generation lifecycle alias.

No database schema or data migration is part of WP-10.

## Validation and comparison

The required local checks are:

```text
pnpm typecheck
pnpm vitest run packages/infrastructure/src/llm packages/application/src/agent packages/application/src/chat/__tests__/chat-turn.test.ts src/components/ChatInterface.test.tsx
pnpm eval:agent:mock
pnpm eval:retrieval
pnpm eval:agent:adversarial
pnpm eval:agent:cost
pnpm gate
pnpm gate:build
git diff --check
```

Real-provider behavior, latency, prompt-cache savings, and cost comparisons
remain **UNVERIFIED** until the keyed runner is explicitly authorized with its
cost ceiling and the pinned v6 reports are available. A missing or unauthorized
real-model run is not a pass and must not be used to claim the Section 12
real-model thresholds.

## Rollout and rollback

Deploy the WP-10 commit through the normal preview/canary path and compare
provider tool calls, schema validation, stream completion, usage telemetry, and
error rates with the pinned v6 reports. Do not broaden model/provider rollout
while any adapter capability or real-model gate is unresolved.

Rollback is a revert of the isolated WP-10 commit. That restores all SDK and
provider versions, the lockfile, and their call-site compatibility code as one
unit. No database rollback is required. Do not partially downgrade individual
SDK packages because the core, provider packages, React package, and provider
protocol are version-coupled.
