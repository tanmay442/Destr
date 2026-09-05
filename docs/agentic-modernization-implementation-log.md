# Agentic Modernization Implementation Log

This log records phase evidence for the single WP-0 through WP-9 implementation
branch. It is intentionally secret-free. Machine-generated reports are ignored
artifacts; their hashes and paths are recorded here after generation.

## Branch and baseline

- Branch: `codex/agentic-tooling-search-modernization`
- Base and initial HEAD: `e22b95119bceba09be0c5b4e0089920b1dc623f2`
- Base subject: `feat(rag): overhaul chunking and segment retrieval (#74)`
- Node.js: `v24.20.0`
- Package manager: `pnpm 10.33.2`
- AI SDK: `6.0.221`
- Lockfile SHA-256:
  `1596de09ae78bda0109a06e4b8aef4d6c08f8ca41018fc5779a6b157ce3f984f`
- Initial untracked user files: the approved modernization plan and its
  companion observability specification. They were preserved when the branch
  was created.

## WP-0 — Pin the baseline

Status: complete; ready for the signed WP-0 commit

### Pre-change command evidence

Captured before application behavior changes on 2026-09-05 (Asia/Kolkata):

| Command | Exit | Evidence |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Lockfile current; five workspace projects; no dependency mutation |
| `pnpm gate` | 0 | 162 test files passed, 6 skipped; 1,515 tests passed, 81 skipped; typecheck, lint, and architecture passed |
| `pnpm eval` | 0 | 35 mock cases passed; mean faithfulness 1.00; document-hit gate was inactive and its 100% pass rate was vacuous |
| `EVAL_REAL=1 pnpm eval` | 1 | Unverified: `CUSTOM_LLM_API_KEY` and `CUSTOM_LLM_BASE_URL` unavailable to the runner; no real-model baseline was produced |
| `pnpm db:check` | 0 | 32 migrations and 32 snapshots; journal consistent |

The skipped database-backed tests are baseline evidence only, not a claim that
the database-complete gate passed. The required local pgvector run remains a
later mandatory gate.

### Deployment and runtime snapshot

Read-only Vercel CLI inspection on 2026-09-05 resolved the linked project as
`rag_agent` under the expected owner scope. A narrow project API query reported:

- framework `nextjs`;
- Node.js `24.x`;
- Fluid Compute enabled;
- default function region `iad1`;
- no project-level function override returned by the queried fields.

Repository source still sets chat `maxDuration = 60` seconds and domain
`MAX_DURATION_MS = 60_000`. No chat memory override is declared. The effective
Vercel plan/tier, memory allocation, service quotas, file-descriptor use, and
burst capacity remain unknown and must not be inferred from project metadata.

### Model, data, and service inputs

- Static adapters support Google, Ollama, and OpenAI-compatible chat; Google,
  Ollama, and OpenAI embeddings; cosine/local/Cohere reranking.
- The deployment-candidate baseline uses the OpenAI-compatible provider adapter,
  model `muse-spark-1.3-contributor-free`, and the Responses operation. A direct
  authenticated probe and the 35-case evaluator both succeeded. Provider RPM,
  TPM, concurrency, context, output, and streaming quotas remain unverified.
- The real-model run uses the tracked `synthetic-mock-corpus.v2` snapshot and
  never loads the database. Live document/chunk counts, stable document digest,
  embedding distribution, and index fingerprint remain unverified.
- Database configuration defaults to a five-connection production Neon pool,
  is capped at twenty, and uses a 30-second general statement timeout. Effective
  Neon compute/pooler limits and live utilization remain unverified.
- Upstash is not configured in the local environment, so local cache/rate-limit
  behavior uses process-local adapters. Deployment tier, region, limits, and
  latency remain unverified.

Unknown inputs are recorded as unknown; none is represented as zero or replaced
with a guessed capacity claim.

### Frozen workload vocabulary

The versioned WP-0 profiles use `active_turns`, never bare “users.” They freeze
scenario mix, cache warmth, cancellation/disconnect assumptions, token/duration
distributions, open-loop and closed-loop methods, and staged 100/500/1,000/4,000
loads. The 30-minute 4,000-active soak is required. The separate 20,000-active
profile requires explicit run authorization, an approved non-production target,
and a paid-provider cost cap. All currently unmeasured distributions are marked
`planning_assumption_pending_trace_measurement`.

### Baseline defects retained as evidence

- The initial golden document-hit gate was vacuous.
- The corrected mock golden run now has 35 categorized cases, 27 labelled
  document-hit cases, a 100% labelled-hit pass rate, and mean lexical
  faithfulness 1.00. Mock-only document IDs are isolated from real-corpus
  expectations, so this result is not represented as real-corpus evidence.
- The existing eval is retrieval plus one-shot generation, not the production
  agent loop.
- The real-model synthetic baseline passed overall while retaining six
  per-case baseline failures: `claim-portal-login`, `refund-timeline`,
  `dental-xray`, `claim-appeal`, `refund-exchange`, and `refund-shipping`.
- Current telemetry cannot observe all required per-step cache, queue, pool,
  SSE, judge-volume, and cost fields.
- Provider, Vercel plan, Neon, Upstash, and live corpus capacity inputs are
  incomplete.

These gaps are not deleted from reports or treated as passes.

### Delegated audits

All WP-0 delegates used `gpt-5.6-luna` at `max` reasoning and were prohibited
from committing, pushing, merging, deploying, changing shared configuration, or
weakening gates.

Every brief identified its finding/work-package ID, objective, exact allowed
files, prohibited files/actions, plan invariants, commands, and required
evidence. The no-commit instruction was explicit in every brief.

- `WP0-AUDIT-CONFIG`: read-only configuration/capacity inventory. Allowed:
  repository reads and non-mutating inspection. Prohibited: all edits and all
  external mutations. Invariants: no secrets or guessed capacity values.
  Evidence required: model/provider, corpus, Vercel, database, Upstash, quota,
  toolchain, and lock inputs with exact file references. Result: confirmed the
  static fingerprints and named the missing quota/corpus/runtime inputs above.
- `WP0-AUDIT-EVAL`: read-only golden/eval inventory, followed by an isolated
  fixture task limited to `scripts/eval/agent-baseline-cases.ts` and its test.
  Invariants: synthetic identities/content, stable IDs/categories, real/mock
  separation, no claimed release quota. Required checks: focused Vitest and
  typecheck. Result: a validated 17-case representative catalog covering every
  Section 11.4 category and explicitly reporting all remaining quota gaps.
- `WP0-AUDIT-GATE`: read-only gate/architecture/measurement audit. Allowed:
  non-writing commands and repository inspection only. Required evidence:
  exact gate blind spots, fixture strategy, measurement availability, and
  file/line citations. Result: found dependency-cruiser omitted type-only
  package imports and identified the unavailable operational measurements.
- `WP0-REVIEW-1`: fresh read-only independent review of the entire plan,
  companion specification, cumulative diff, all untracked implementation
  files, privacy/security, architecture, tests, configuration, and
  reversibility. Required output: severity, file/line, violated plan item,
  correction, code-blocker status, and separate external exit blockers.
  Result: seven P1 code findings and one P2 later-layer coverage gap; commit was
  rejected pending correction.
- `WP0-FIX-ARCH`: edits limited to `scripts/architecture-policy.ts` and its
  test. Invariants: one complete forbidden-family policy, exact WP-5
  compatibility exceptions, and negative fixtures through the actual gate.
  Required checks: focused tests, typecheck, architecture, ESLint, and diff
  check. Result: all canonical package families and five import forms covered;
  97 focused tests passed.
- `WP0-FIX-WORKLOAD`: edits limited to `scripts/eval/workload-profile.ts` and
  its test. Invariants: explicit `active_turns`, assumption labels, open/closed
  loop semantics, 30-minute soak, separate 20,000-active authorization, and no
  capacity claim. Required checks: positive/negative validation tests,
  typecheck, and ESLint. Result: explicit arrival/ramp/steady, completion-driven
  concurrency, downstream distributions, and ordering/percentage invariants;
  6 focused tests passed.
- `WP0-FIX-MOCK-CORPUS`: edits limited to golden/harness/run eval files and one
  synthetic corpus module. Invariants: independently authored labels, stable
  document/chunk IDs, distractors, mock/real separation, real fail-closed, no
  proprietary data. Required checks: hit and forced-miss tests, real-label
  isolation, report metadata, focused tests, typecheck, and diff check. Result:
  a fixed seven-record synthetic corpus, explicit labels, versioned report with
  commit/mode/metrics, and 34 focused tests passed.

### WP-0 candidate evidence

- Focused WP-0 suites, typecheck, ESLint, and diff checks passed after the final
  trace/progress changes.
- A fresh base `pnpm gate` and candidate `pnpm gate` both exited 0. The candidate
  gate included Vitest, typecheck, ESLint, dependency-cruiser, and the new
  source/manifest architecture policy.
- Corrected mock `pnpm eval`: passed all 35 categorized cases with an active
  document-hit gate over 27 retrieval cases.
- Real synthetic `pnpm eval:trace`: passed overall for
  `muse-spark-1.3-contributor-free` across 35 cases. Mean faithfulness was 0.83
  against the 0.70 threshold, mean correctness was 0.86, mean context relevancy
  was 1.00, and all 27 labelled retrieval cases hit their expected document.
  Generation p50/p95/p99 was 9.43/37.58/44.10 seconds. Three provider timeouts
  recovered through bounded serial retries.
- Trace mode records the complete synthetic request, response, expected labels,
  performed evaluation, retrieved stable IDs, scores, timings, and attempts in
  ignored `eval/model-interactions.jsonl`; it also prints per-case progress.
  Evidence, measurement, and baseline scripts print bounded phase/command
  progress. A sensitive-pattern scan of the complete trace and report passed.
- Complete-run artifact hashes captured before the duplicate evidence rerun:
  golden report `ec594b275dd808da859a67b2dd5384eee426bd9bd200a1896939735648ce5c5b`;
  interaction trace `9123946d305733a00ca54cc2f3f4b758173deedaa2f1944a2fcd1cfc8abd8046`.
- A duplicate fixed evidence capture was stopped at the user's direction after
  its base gate, candidate gate, and mock eval had all passed; the already
  completed real baseline above is the WP-0 model evidence.
- `pnpm db:check`: 32 migrations and 32 snapshots; journal consistent.
- `pnpm build` passed with an ephemeral test-only cursor signing value. Existing
  warnings about filesystem blob storage, in-memory Redis fallback, disabled
  async ingest, metadata base, and broad NFT tracing remain deployment inputs.

The versioned baseline reporter now requires exactly one typed record for every
mandatory command, validates mock report schema/mode/commit/freshness/gate
state, records effective model/provider defaults and override provenance, and
accepts only schema-validated measurement evidence tied to the baseline commit.
No such operational measurement source was available for this run, so every
missing metric remains explicitly `not_observable` rather than fabricated.

The WP-0 exit criteria are met for the configured deployment-candidate model:
the full gate, mock eval, and real-model synthetic baseline all passed. Missing
production telemetry and service quotas remain named inputs rather than guessed
capacity claims.

### Independent reviewer

The first reviewer read the full 2,789-line plan and companion specification,
then rejected the candidate with seven P1 code findings: missing measurement
input support, circular mock labels, incomplete vendor-family policy, incomplete
workload semantics/validation, permissive report validation, incomplete
effective model provenance, and incomplete delegation evidence. The correction
cycle above addressed the first-pass findings and reran the focused and full
gates.

The correction re-review also rejected commit. It confirmed privacy,
reversibility, redaction, and the reported gates, but required further work on:

- a real read-only producer and stronger provenance for baseline operational
  measurements;
- consistency between agent-fixture document/chunk UIDs and a fixed synthetic
  corpus;
- a process-level negative architecture fixture through the repository gate;
- measured-mean versus percentile semantics in the workload arrival model; and
- exact command argv/exit/timestamp/output hashes plus source/config/corpus and
  dirty-tree fingerprints in eval evidence.

The correction work added typed command evidence, fixed-corpus measurement
evidence, stable identities, real-process architecture negatives, workload
semantics, Responses API support, serial bounded retry behavior, complete
synthetic interaction tracing, and safe progress output. No blocking code
finding remains in the coordinator's cumulative and phase-diff review. At the
user's explicit direction, the prior reviewer cycles were accepted without
starting another reviewer agent. WP-1 was not started.
