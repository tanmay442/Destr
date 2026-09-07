# WP-2 retrieval decision and rollback

## Decision

WP-2 enables `weighted_websearch` lexical retrieval by default while retaining
`content_plain` as an independently selectable runtime rollback path. The
candidate path uses a stored weighted `search_tsv` vector (`title` weight A,
`section_title` weight B, `content` weight D), `websearch_to_tsquery`, and
`ts_rank_cd`. The legacy path continues to use the existing content-only `tsv`,
`plainto_tsquery`, and `ts_rank`.

The reranker uses an independent `rerankerThreshold` of `0.5`; cosine filtering
continues to use `similarityThreshold`. This threshold is supported by a
reproducible synthetic probe of the local `Xenova/ms-marco-MiniLM-L-6-v2`
adapter on `@xenova/transformers` 2.17.2. Three relevant pairs scored at least
0.999334 and six negative pairs scored at most 0.000014, so 0.5 separated this
fixture with zero false positives and zero false negatives. It is not
production-corpus calibration. Cohere and every other production adapter or
corpus require their own labeled calibration before enablement; the default
`cosine` provider does not activate this threshold.

## Evidence

The reproducible PostgreSQL evaluation is
`DATABASE_URL=<local-pgvector-url> pnpm tsx scripts/eval/wp2-retrieval.ts`. Its
ignored machine-readable artifact is `eval/wp2-retrieval-report.json`.
The reranker fixture is
`scripts/eval/fixtures/wp2-reranker-calibration.json`; run
`pnpm tsx scripts/eval/wp2-reranker-calibration.ts` to produce the ignored
`eval/wp2-reranker-calibration-report.json`. Both reports fingerprint the full
candidate source tree, including non-ignored untracked files. The retrieval
report additionally fingerprints complete corpus content, queries, relevance
judgments, effective configuration, migration, and schema.

On the synthetic WP-2 corpus, the legacy path produced Recall@5 0.20, MRR@10
0.20, nDCG@10 0.20, no-match precision 0.25, and no-match recall 1.00. The
candidate path produced Recall@5 1.00, MRR@10 1.00, nDCG@10 1.00, no-match
precision 1.00, and no-match recall 1.00. Deterministic stable-identity backfill
was 1/1. These numbers approve F-17 for the tested synthetic exact-term,
error-code, title, section, phrase, Boolean-OR, and no-match cases; they do not
claim production quality or capacity.

F-07 is closed by keeping an independently configured, validated 0..1 reranker
threshold and applying it only to successful reranker scores. Invalid or
incomplete reranker output degrades to the existing dense-threshold path.
F-16 is closed by using `chunkUid` and then `documentId:chunkIndex` consistently
for fusion, resolution, grounding, citation deduplication, and bounded
cross-call backfill. Window and segment results retain every constituent chunk
identity and emit constituent citations, so a later anchor cannot re-emit
content already present inside an earlier resolved context.

## Database migration

Migration `0032_curious_odin.sql` adds one stored generated column and one GIN
index. It is additive: the existing `tsv` column and index remain intact, so old
application code is compatible both before and after the migration. It was
rehearsed against the local PostgreSQL 16 pgvector database, followed by both
split-port and composite repository contract suites with no skipped cases.

Adding a stored generated column computes values for existing rows, and the
non-concurrent index creation can hold locks and consume I/O on a large chunks
table. Production migration therefore requires an approved maintenance window
or a separately reviewed concurrent-index procedure after measuring table size
and lock tolerance. WP-2 does not deploy or approve that production operation.

## Rollout and rollback

- Owner: retrieval/platform maintainer.
- Default: `LEXICAL_SEARCH_MODE=weighted_websearch` after the migration exists.
- Immediate application rollback: set
  `LEXICAL_SEARCH_MODE=content_plain` and restart the application. The explicit
  `content_plain` value is a one-way environment kill switch that overrides a
  conflicting runtime database setting without requiring `APP_SETTINGS_LOCK`.
  This retains the additive column/index and restores the prior lexical path.
- Stop conditions: any material per-category nDCG regression, Recall@5 below
  0.90, MRR@10 below 0.80, no-match precision below 0.95, no-match recall below
  0.90, or p95 single-search latency regression above 15% without approval.
- Schema cleanup, only after the application rollback is verified and the
  rollback window is closed: drop `chunks_search_tsv_idx`, then drop
  `chunks.search_tsv` in a separately reviewed migration. Schema cleanup is not
  required for immediate rollback and must not be performed during incident
  response without a lock-impact review.
- Removal condition: remove `content_plain` only after production-corpus metrics
  and latency remain within gates for the agreed rollback window.

Remote Cohere requests inherit caller cancellation and share one hard 10-second
retry budget. Local Xenova model loading/tokenization/inference cannot be
preempted once native work has started; callers nevertheless stop waiting on
cancellation or the hard 10-second budget, and late failures are observed to
prevent unhandled rejections.
