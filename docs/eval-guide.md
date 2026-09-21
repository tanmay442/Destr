# Evaluation Guide (corpora + runner usage)

Secret-free. No credentials, personal data, production transcripts, or
proprietary document content. Real-model runs record only sanitized
identifiers (`sanitizeIdentifier`) plus present/unset key presence — never
key values.

Source of truth is code, not this document. Runner entry points live in
`scripts/eval/`; script names below are `package.json` scripts. On any
conflict the runner headers win.

---

## 1. Runners

### `pnpm eval` — golden Q&A (`scripts/eval/run.ts`)

- Default mode is `mock`: deterministic synthetic retrieval
  (`searchSyntheticMockCorpus`) + echo generation, no network or DB.
- `EVAL_REAL=1 pnpm eval` selects a keyed mode: `real` (live database
  retrieval + configured chat model and graders) or, with
  `EVAL_CORPUS=synthetic`, `real_synthetic` (synthetic retrieval + real
  candidate generation with required-signal grading; stays serialized with
  bounded retries for free-tier providers).
- `pnpm eval:trace` is the traced variant: `EVAL_REAL=1
  EVAL_CORPUS=synthetic` plus `--trace-model-interactions`, which appends
  sanitized request/response/error records to
  `eval/model-interactions.jsonl`. The trace flag is rejected in any other
  mode.
- Report: `eval/golden-report.json` (`golden-report.v1`). Every per-question
  line prints faithfulness / correctness / context-relevancy, doc-hit state,
  and retrieval/generation/total latency.
- WP-9 default retrieval path: every golden question runs the direct
  single-query hybrid retrieval (the old rewrite/retry wrapper was removed);
  the structured orchestrator remains the only explicit agentic-mode path,
  and its offline comparison lives in `wp4-retrieval.ts` (see §4).

### `pnpm eval:retrieval` — retrieval-only gate (`scripts/eval/retrieval-run.ts`)

- Mock only. Runs the golden questions through `mockEvalDeps` and writes
  `eval/retrieval-report.json`.
- Fails closed twice: an invalid `EVAL_FAITHFULNESS_THRESHOLD` exits 1, and
  an inactive doc-hit gate (no retrieval case carries an expected document
  label) exits 1 because the gate would be vacuous.

### `pnpm eval:agent:mock` — scripted agent trajectories (`scripts/eval/agent-run.ts --model scripted`)

- Drives `AGENT_GOLDEN_CORPUS` through a scripted model backend, alternating
  native and emulated tool-capability modes per case. Writes
  `eval/agent-mock-report.json` (`agent-eval-report.v1`, gate `mock`).
- Pass requires every trajectory to pass; any failure exits 1.

### `pnpm eval:agent:real` — keyed real-model matrix (`scripts/eval/agent-run.ts --model configured`)

- Matrix: primary plus fallback model (`EVAL_MODEL_ID`,
  `EVAL_FALLBACK_MODEL_ID`) × native/emulated capability modes × 3 repeats.
  Case selection under `EVAL_AGENT_MAX_CASES` is stratified round-robin
  across primary categories so every behavior family stays represented.
- Spend guard: estimated $0.005 per call against `EVAL_COST_CEILING_USD`;
  the run stops early at the ceiling. Writes `eval/agent-real-report.json`
  (gate `real`).
- Keyed runs require explicit authorization (`EVAL_AGENT_ALLOW_KEYED=1`),
  a positive cost ceiling, provider keys, a fallback model id, and a
  positive integer case limit — otherwise the runner writes an `unverified`
  report and exits 2 (see §6).

### `pnpm eval:agent:adversarial` — fault injection (`scripts/eval/adversarial-run.ts`)

- Synthetic chaos faults (embedding/vector/lexical errors, timeouts,
  deadline pressure, prompt/tool-output injection) executed through the
  production tool modules with scripted backends, plus a canary token that
  must never appear in serialized run state (redaction check). Writes
  `eval/agent-adversarial-report.json` (gate `adversarial`).
- Any unsafe fault handling exits 1.

### `pnpm eval:agent:cost` — latency/cost sampling (`scripts/eval/cost-run.ts`)

- Samples loop-level latency and token counts per scenario: `no_tool`,
  `one_search`, `two_search`, `retry_backfill`, `degraded`, `budget_stop`.
  Writes `eval/agent-cost-report.json` (gate `cost`).
- Provider pricing is unconfigured, so turn cost is reported `unknown`
  explicitly, never zero; planner/embedding/reranker/verifier roles, Redis
  and DB ops, SSE bytes, and Vercel compute are called out as unmeasured.
  Any grading failure exits 1.

---

## 2. Corpora

### Golden Q&A (`scripts/eval/golden.ts`)

- Phrase-based questions: `{ id, question, mustMention, forbidden?,
  refusalExpected? }`, categorized as `exact_term`, `semantic_paraphrase`,
  or `out_of_scope`.
- Retrieval-mode label `mode?: 'agentic' | 'normal'` is reporting-only; both
  labels run the same direct hybrid path in this harness.
- Retrieval labels: `expectedDocIds` (live corpus) and, for the CI-safe
  synthetic corpus, `expectedMockDocIds` / `expectedMockChunkUids`. Cases
  without an expected label set no doc-hit expectation (`hit` undefined).

### Agent golden corpus (`scripts/eval/agent-golden-corpus.ts`)

- Version `agent-golden-corpus.v1`. Synthetic-only fixtures invented from
  the password/dental/claim/dress/refund guides plus generic distractors;
  retrieval labels reference the fixed synthetic mock corpus document IDs
  101–107.
- 16 primary categories (`doc_search`, `casual_no_tool`, `clarification`,
  `no_match`, `infra_error`, `ticket_request`, `ticket_denied`,
  `multiturn_reference`, `injection`, `budget_timeout`, `overlap_two_calls`,
  `backfill`, `two_subquestions`, `dominant_topic`, `similar_chunks`,
  `packing_limits`), each with a plan-minimum case count. A case may count
  toward several categories via `categories` membership.
- Grounding expectations are `verified` | `rejected` | `unverified` |
  `not_required`.

### Mock corpus (`scripts/eval/mock-corpus.ts`)

- Version `synthetic-mock-corpus.v2`. Fixed CI-only records (`relevant` |
  `distractor`) keyed by `documentId`, `documentUid`, and `chunkUid`, with a
  `syntheticMockCorpusManifest` used for fingerprinting. Distractors force
  mock retrieval to exercise ranking rather than query-to-document lookup.

---

## 3. Fingerprints and provenance

- `fingerprint(parts)` (both `scripts/eval/harness.ts` and
  `scripts/eval/agent-report.ts`) is `sha256` over NUL-joined parts,
  rendered `sha256:<hex>`.
- Golden reports carry `baselineCommit` (`VERCEL_GIT_COMMIT_SHA` or git
  `HEAD`), `candidateModelId` (sanitized), `manifestIdentity`,
  `sourceFingerprint` (commit + tracked index + staged/worktree diffs +
  untracked-files fingerprint), `configFingerprint` (mode, candidate,
  threshold, delays, observed env keys, key presence only), and
  `corpusFingerprint` / `dirtyTreeFingerprint`.
- Agent reports carry `corpusId` (`agent-golden-corpus.v1`),
  `corpusFingerprint`, `documentSnapshotId`
  (`synthetic-mock-corpus.v2`), `toolContractVersion`
  (`tool-catalog-v1`), and a `config.v1` config fingerprint naming the gate
  (and, for real runs, models, repeats, ceiling, and selection).
- Untracked files are fingerprinted by path + `git hash-object`, never by
  raw content.

---

## 4. `wp4-retrieval.ts` comparison

`scripts/eval/wp4-retrieval.ts` compares direct (`normal`) versus
planner/orchestrator retrieval on a synthetic in-memory corpus (no
production data) and writes `eval/wp4-retrieval-report.json`
(`wp4-retrieval-report.v1`). Gates (all must pass):

| Gate | Requirement |
|---|---|
| `recallAt5` | ≥ 0.9, both paths |
| `mrrAt10` | ≥ 0.8, both paths |
| `noMatchPrecision` | ≥ 0.95, both paths |
| `noMatchRecall` | ≥ 0.9, both paths |
| `ndcgRegression` | ≤ 0.02 |
| `docHitGate` | active, ≥ 0.8 both paths |
| `perCategoryNdcgRegression` | ≤ 0.02 every single-intent category |
| `quota` / `backfill` / `dominantRetention` | exactly 1 |

Decision is `planner_accepted_shadow` only when the planner improves a rank
metric with no gate failing and p95 latency regressing by no more than 15%;
otherwise `planner_rejected_keep_normal` (default stays `normal`).
Compound multi-concept cases are evaluated per subquestion, never globally
reranked. Real-model and production-path gates are explicitly not claimed.

---

## 5. Gate thresholds summary

| Runner | Pass condition |
|---|---|
| `pnpm eval` | Per question: refusal consistent with expectation, `faithfulness === 1`, no `forbiddenHit`, `correctness >= 0.5`. Overall: `meanFaithfulness >= EVAL_FAITHFULNESS_THRESHOLD` (default `0.7`, invalid values fail closed), judge faithfulness (when present) ≥ threshold, doc-hit gate active, `passRate >= 0.8`. |
| `pnpm eval:retrieval` | Same threshold gate on mock deps, plus fail-closed on inactive doc-hit gate. |
| `pnpm eval:agent:mock` | All scripted trajectories pass (tool selection, argument validity, stop reasons, safety). |
| `pnpm eval:agent:real` | Full matrix passes, or `unverified` (exit 2) under §6 conditions. |
| `pnpm eval:agent:adversarial` | Every injected fault handled safely with redaction intact. |
| `pnpm eval:agent:cost` | Every sampled run grades pass; cost `unknown` is explicit, not a failure. |
| `wp4-retrieval.ts` | Every gate in §4 passes. |

CI (`.github/workflows/eval.yml`) runs the keyed real eval plus the agent
real-model matrix on schedule/manual dispatch (weekly Monday 03:00 UTC),
auto-opening/closing a failure issue; every PR to `master` runs the mock
gates (`eval`, `eval:retrieval`, `eval:agent:mock`,
`eval:agent:adversarial`, `eval:agent:cost`) and uploads
`eval/golden-report.json` plus `eval/agent-*.json` as build artifacts.

---

## 6. Real-model `UNVERIFIED` policy

A real-model run that cannot complete inside its authorization, budget, or
availability envelope is reported `unverified` — never as a pass:

- `eval:agent:real` writes an empty-result `unverified` report and exits 2
  when any of these holds: `EVAL_AGENT_ALLOW_KEYED` is not `1`, no positive
  `EVAL_COST_CEILING_USD`, no provider keys, no `EVAL_FALLBACK_MODEL_ID`
  (primary plus at least one fallback adapter is required), or
  `EVAL_AGENT_MAX_CASES` is not a positive integer.
- A started matrix that exhausts the cost ceiling, or whose every run fails
  with provider/network error categories (connection, fetch/socket,
  timeouts, 401/403/429/5xx, quota/rate-limit, unavailable/refused), is
  likewise `unverified` (exit 2): a flaky or unavailable provider is
  unverified, not a pass.
- Only a completed matrix with zero failures is `pass`; any non-provider
  failure is `fail` (exit 1).
