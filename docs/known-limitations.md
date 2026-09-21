# Known Limitations (WP-9)

Secret-free. Each item below names its evidence source. Labels in caps are
load-bearing: do not soften, relabel, or claim them as verified without new
gated evidence.

## Unverified at scale (source: `docs/agentic-modernization-agent-logs/wp8.md`)

- real 4,000-turn soak UNVERIFIED — no approved environment, quotas, or cost
  ceiling; the load agent refuses everything until then (`wp8.md:203-207`;
  gate evidence `wp8.md:221`, `EVAL_REAL=1 … exit 2 UNVERIFIED` at `wp8.md:233`).
- real 20,000-turn ramp UNVERIFIED — same gate; peak-20k additionally requires
  explicit approval plus a matching cost-cap confirmation (`wp8.md:207, 248`).
- real-model prompt-cache reuse/billing UNVERIFIED — synthetic + isolated
  local evidence only; per-step parsing, capability, and billing-completeness
  coverage is mock/fixture based (`wp8.md:207-209`;
  `packages/infrastructure/src/llm/__tests__/prompt-cache-capability-wp8.test.ts`).
- production-scale HNSW/pool behavior UNVERIFIED — bulk-SQL evaluation was
  rejected with local EXPLAIN evidence on a small synthetic DB (GIN 3.8/5.0 ms,
  filtered vector 5.6 ms, unfiltered exact-scan 35.6 ms; HNSW not chosen at
  small scale), and no pool growth is claimed as capacity (`wp8.md:83-86`;
  residual at `wp8.md:298-299`).

## Planner quality status

On the WP-4 pinned synthetic corpus (7 documents / 8 cases,
`scripts/eval/wp4-retrieval.ts`), planner vs normal hybrid: Recall@1
0.9167/0.9167, Recall@3/5/10 1.0/1.0, MRR@10 1.0/1.0 — recall ties —
nDCG@10 1.0/0.9866 (-0.0134, inside the 0.02 regression budget); all ten
gates passed, decision `planner_rejected_keep_normal`
(source: `docs/agentic-modernization-agent-logs/wp4.md:320-345`).

The planner was therefore rejected-as-default on that synthetic ceiling
corpus and stayed behind its (now deleted) disabled-by-default flag. WP-9
retains the structured orchestrator as the single agentic search path for
its structural guarantees (`docs/agentic-modernization-agent-logs/wp4.md:236-244`).
It does not promote it to the default: normal hybrid retrieval remains the
safe static/runtime default, and an explicit `retrievalMode: 'agentic'`
override is required to select the orchestrator. The orchestrator
(`packages/application/src/agent/search/search-orchestrator.ts`) provides F-05
(separate model-step vs search-attempt vs physical vs token budgets with a
hard total-call ceiling), F-21 (prior normalized-text dedup — one physical
retrieval serves all subquestions sharing that text), F-22
(quality/coverage assessment with explicit reason codes gates the one
follow-up round), F-26 (one `subquestionId` is the ranking unit; no global
cross-intent rerank; per-subquestion quotas), F-27 (stable-identity dedup;
scores never used as identity), F-28 (all seven budget dimensions
independently enforced) — plus typed stop/partial/exhaustion reasons and
typed infrastructure errors that can never authorize a write tool. That
opt-in rests on the same synthetic evidence, not on new measurements: a
real-model planner-vs-normal comparison on a production corpus is still
pending, and the WP-4 numbers above stand unrevisited.

## Pool-lifecycle hook

There is no runtime pool-lifecycle hook in this stack. Evidence: the
`pool-metrics.ts` module header states "No implicit global Vercel hook is
assumed" (`packages/infrastructure/src/db/pool-metrics.ts:1-22`), and
`tryAttachPoolLifecycle` (`pool-metrics.ts:243-251`) reports `supported:
false` ("No pool lifecycle hook is exposed by this runtime; pool shutdown
stays with process exit") whenever no hook is provided, by design and without
throwing. The dependency tree contains no `@vercel/functions` package, so no
implicit global hook exists to attach to. Pool shutdown stays with process
exit; the module is tested and documented, activation is deferred
(`wp8.md:213-215`).

## Compaction is truncation

History compaction is deterministic truncation of the oldest unprotected
messages with a ceil(chars/4) token estimate — not summarization
(`packages/application/src/chat/history-compaction.ts:22-24`; `wp8.md:99-100`).
It preserves the current request, approvals, constraints, and a recent
window, and surfaces `over_budget` to the turn seam.
