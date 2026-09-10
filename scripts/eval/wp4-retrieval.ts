import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { searchChunks, type SearchDeps } from '@app/application';
import { runStructuredSearch, createDeterministicPlan, packEvidence } from '@app/application/agent/search';
import type { RetrievedChunkRow } from '@app/domain';

const REPORT_PATH = join('eval', 'wp4-retrieval-report.json');

interface SyntheticDoc {
  readonly key: string;
  readonly documentId: number;
  readonly title: string;
  readonly section: string;
  readonly content: string;
  readonly terms: readonly string[];
}

const CORPUS: readonly SyntheticDoc[] = [
  { key: 'error-code', documentId: 101, title: 'ERR-4291 Rate Limit', section: 'API errors', content: 'ERR-4291 rate limit exceeded. Wait briefly and retry the request with backoff.', terms: ['err-4291', 'rate', 'limit', 'retry', 'backoff'] },
  { key: 'password-reset', documentId: 102, title: 'Password Reset', section: 'Account', content: 'Use the verified password reset workflow from account settings.', terms: ['password', 'reset', 'account', 'workflow'] },
  { key: 'cell-policy', documentId: 103, title: 'School Cell Phone Policy', section: 'Policy', content: 'School cell phone policy prohibits use during class hours.', terms: ['school', 'cell', 'phone', 'policy', 'class'] },
  { key: 'refund', documentId: 104, title: 'Refund Deadline', section: 'Billing', content: 'Refund deadline is 30 days from purchase for annual plans.', terms: ['refund', 'deadline', '30', 'days', 'annual'] },
  { key: 'sso', documentId: 105, title: 'SSO Setup', section: 'Authentication', content: 'Configure single sign-on SSO with SAML for your organization.', terms: ['sso', 'single', 'sign-on', 'saml', 'configure'] },
  { key: 'vpn', documentId: 106, title: 'VPN Guide', section: 'Network', content: 'Virtual private network VPN setup for remote access.', terms: ['vpn', 'virtual', 'private', 'network', 'remote'] },
  { key: 'distractor', documentId: 107, title: 'General FAQ', section: 'Misc', content: 'Unrelated general information about office hours.', terms: ['office', 'hours', 'general'] },
];

interface EvalCase {
  readonly id: string;
  readonly category: string;
  readonly query: string;
  readonly relevantKeys: readonly string[];
  readonly subquestions?: readonly { id: string; relevantKeys: readonly string[] }[] | undefined;
}

const CASES: readonly EvalCase[] = [
  { id: 'already-good', category: 'exact_term', query: 'school cell phone policy', relevantKeys: ['cell-policy'] },
  { id: 'error-code', category: 'error_code', query: 'ERR-4291 retry', relevantKeys: ['error-code'] },
  { id: 'quoted', category: 'exact_term', query: '"refund deadline" 30 days', relevantKeys: ['refund'] },
  { id: 'vague', category: 'semantic_paraphrase', query: 'please help me with my phones and stuff', relevantKeys: ['cell-policy'] },
  { id: 'version', category: 'exact_term', query: 'Acme VPN v2.4.1 split tunnel fails', relevantKeys: ['vpn'] },
  {
    id: 'compound',
    category: 'multi_concept',
    query: 'account lockout policy and refund deadline days',
    relevantKeys: ['password-reset', 'refund'],
    subquestions: [
      { id: 'sq-1', relevantKeys: ['password-reset'] },
      { id: 'sq-2', relevantKeys: ['refund'] },
    ],
  },
  { id: 'out-of-scope', category: 'out_of_scope', query: 'medical diagnosis for symptoms', relevantKeys: [] },
  { id: 'no-match', category: 'no_match', query: 'ZXQJ nonexistent widget frobnicate', relevantKeys: [] },
];

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const STOPWORDS = new Set([
  'for', 'and', 'the', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'were', 'has', 'have', 'had',
  'will', 'would', 'could', 'should', 'please', 'with', 'about', 'into', 'over', 'after', 'before',
]);

function tokensForTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s"-]/g, ' ')
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

function scoreDoc(query: string, doc: SyntheticDoc): number {
  const terms = tokensForTerms(query);
  if (terms.length === 0) return 0;
  let hits = 0;
  for (const term of terms) {
    const clean = term.replace(/"/g, '');
    if (doc.terms.some((docTerm) => docTerm.includes(clean) || clean.includes(docTerm))) hits += 1;
    else if (`${doc.title} ${doc.section} ${doc.content}`.toLowerCase().includes(clean)) hits += 1;
  }
  return hits / terms.length;
}

function rowsForQuery(query: string): RetrievedChunkRow[] {
  const scored = CORPUS.map((doc, index) => ({ doc, score: scoreDoc(query, doc), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.documentId - b.doc.documentId);
  return scored.map((entry, rank) => ({
    id: entry.doc.documentId * 10 + rank,
    chunkUid: `uid-${entry.doc.documentId}-0`,
    documentId: entry.doc.documentId,
    fileName: 'synthetic.md',
    page: null,
    sectionTitle: entry.doc.section,
    source: `docs/${entry.doc.key}.md`,
    title: entry.doc.title,
    content: entry.doc.content,
    similarity: Math.max(0.1, 0.95 - rank * 0.05),
    parentChunkId: null,
    chunkIndex: 0,
  }));
}

function makeDeps(): SearchDeps {
  return {
    chunks: {
      insertMany: async () => undefined,
      deleteByDocumentId: async () => undefined,
      searchByVector: async () => [],
      searchByLexical: async (query: string) => rowsForQuery(query),
      getByIds: async () => [],
      getByDocAndRange: async () => [],
      getByDocAndRanges: async () => new Map(),
      countForDocuments: async () => new Map(),
      countForAll: async () => 0,
      countForDocument: async () => 0,
      recountAll: async () => [],
    },
    embeddings: {
      embed: async () => [0.1, 0.2, 0.3],
      embedBatch: async () => [[0.1, 0.2, 0.3]],
    },
  } as unknown as SearchDeps;
}

function recallAt(returned: readonly number[], relevant: readonly number[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(returned.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

function reciprocalRank(returned: readonly number[], relevant: readonly number[]): number {
  const set = new Set(relevant);
  const rank = returned.slice(0, 10).findIndex((id) => set.has(id));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

function ndcg(returned: readonly number[], relevant: readonly number[]): number {
  if (relevant.length === 0) return 1;
  const set = new Set(relevant);
  const dcg = returned.slice(0, 10).reduce((total, id, index) => total + (set.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.length, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  return ordered[lower] ?? 0;
}

async function main(): Promise<void> {
  const deps = makeDeps();
  const config = {
    corpus: 'synthetic-wp4-planner.v1',
    resultLimit: 5,
    candidateLimit: 30,
    maxResultsPerSubquestion: 3,
    maxResultsPerSearchCall: 10,
  };
  const configSha = sha256Json({ config, corpus: CORPUS.map((doc) => doc.key), cases: CASES.map((c) => c.id) });

  const normalRows: { id: string; returned: number[]; candidateCount: number; candidateCountByModality: { vector: number; lexical: number }; latencyMs: number }[] = [];
  const plannerRows: { id: string; returned: number[]; candidateCount: number; candidateCountByModality: { vector: number; lexical: number }; predicted: 'results' | 'no_match' | 'error'; noMatchReasons: string[]; latencyMs: number; strategies: string[]; perSubquestion: { id: string; recallAt5: number; coverage: string }[]; uniqueCount: number; tokens: number }[] = [];

  for (const evalCase of CASES) {
    const relevantIds = evalCase.relevantKeys.map((key) => CORPUS.find((doc) => doc.key === key)?.documentId ?? -1);
    const startedNormal = performance.now();
    const normalResult = await searchChunks(evalCase.query, { limit: 5, candidateLimit: 30, hybridEnabled: true }, deps);
    const normalLatency = performance.now() - startedNormal;
    if (!normalResult.ok) throw normalResult.error;
    const normalIds = normalResult.value.chunks.map((chunk) => chunk.documentId);
    normalRows.push({
      id: evalCase.id,
      returned: normalIds,
      candidateCount: rowsForQuery(evalCase.query).length,
      candidateCountByModality: { vector: 0, lexical: rowsForQuery(evalCase.query).length },
      latencyMs: normalLatency,
    });

    const plan = createDeterministicPlan({ originalQuery: evalCase.query, remainingPlans: 2, remainingMs: 10000 });
    const strategies = plan.subquestions.flatMap((sub) => sub.queries.map((query) => query.strategy));
    const startedPlanner = performance.now();
    const orchestrated = await runStructuredSearch(
      { search: deps },
      {
        originalQuery: evalCase.query,
        callId: `eval-${evalCase.id}`,
        requestedLimit: 5,
        signal: new AbortController().signal,
        budgets: { maxResultsPerSubquestion: 3, maxResultsPerSearchCall: 10, maxCandidatesPerModality: 30 },
      },
    );
    const plannerLatency = performance.now() - startedPlanner;
    const plannerIds = orchestrated.sets.flatMap((set) => (set.kind === 'results' ? set.results.map((item) => item.documentId) : []));
    const variantTexts = [...new Set(plan.subquestions.flatMap((sub) => sub.queries.map((query) => query.text.toLowerCase())))];
    const plannerCandidateCount = variantTexts.reduce((total, text) => total + rowsForQuery(text).length, 0);
    const uniqueKeys = new Set(
      orchestrated.sets.flatMap((set) => (set.kind === 'results' ? set.results.map((item) => item.chunkUid ?? `${item.documentId}:${item.chunkIndex}`) : [])),
    );
    const tokens = orchestrated.evidenceTokens;
    const plannerKinds = orchestrated.sets.map((set) => set.kind);
    const plannerPredicted = plannerKinds.includes('results')
      ? 'results' as const
      : plannerKinds.includes('error')
        ? 'error' as const
        : 'no_match' as const;
    const plannerNoMatchReasons = orchestrated.sets.flatMap((set) => (set.kind === 'no_match' ? [set.reason] : []));
    const perSubquestion = evalCase.subquestions?.map((sub) => {
      const expected = sub.relevantKeys.map((key) => CORPUS.find((doc) => doc.key === key)?.documentId ?? -1);
      const returnedForSub = orchestrated.sets.find((set) => set.subquestionId === sub.id && set.kind === 'results');
      const ids = returnedForSub && returnedForSub.kind === 'results' ? returnedForSub.results.map((item) => item.documentId) : [];
      return { id: sub.id, recallAt5: recallAt(ids, expected, 5), coverage: returnedForSub && returnedForSub.kind === 'results' ? returnedForSub.coverage : 'partial' };
    }) ?? (() => {
      const returnedForSq1 = orchestrated.sets.find((set) => set.subquestionId === 'sq-1' && set.kind === 'results');
      const coverage = returnedForSq1 && returnedForSq1.kind === 'results' ? returnedForSq1.coverage : 'partial';
      return [{ id: 'sq-1', recallAt5: recallAt(plannerIds, relevantIds, 5), coverage }];
    })();
    plannerRows.push({
      id: evalCase.id,
      returned: plannerIds,
      candidateCount: plannerCandidateCount,
      candidateCountByModality: {
        vector: 0,
        lexical: plannerCandidateCount,
      },
      predicted: plannerPredicted,
      noMatchReasons: plannerNoMatchReasons,
      latencyMs: plannerLatency,
      strategies: [...new Set(strategies)],
      perSubquestion,
      uniqueCount: uniqueKeys.size,
      tokens,
    });
  }

  const answerable = CASES.filter((c) => c.relevantKeys.length > 0);
  const rankedAnswerable = answerable.filter((c) => c.category !== 'multi_concept');
  const compoundCases = answerable.filter((c) => c.category === 'multi_concept');
  const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  const normalMetrics = {
    recallAt1: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 1))),
    recallAt3: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 3))),
    recallAt5: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 5))),
    recallAt10: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 10))),
    mrrAt10: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => reciprocalRank(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? []))),
    ndcgAt10: mean(normalRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => ndcg(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? []))),
  };
  const plannerMetrics = {
    recallAt1: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 1))),
    recallAt3: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 3))),
    recallAt5: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 5))),
    recallAt10: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => recallAt(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? [], 10))),
    mrrAt10: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => reciprocalRank(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? []))),
    ndcgAt10: mean(plannerRows.filter((r) => rankedAnswerable.some((c) => c.id === r.id)).map((r) => ndcg(r.returned, rankedAnswerable.find((c) => c.id === r.id)?.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1) ?? []))),
  };

  const noMatchCases = CASES.filter((c) => c.relevantKeys.length === 0);
  const normalNoMatchPred = normalRows.filter((r) => noMatchCases.some((c) => c.id === r.id) && r.returned.length === 0).length;
  const plannerTypedNoMatch = (id: string): boolean =>
    plannerRows.find((r) => r.id === id)?.predicted === 'no_match';
  const plannerNoMatchPred = noMatchCases.filter((c) => plannerTypedNoMatch(c.id)).length;
  const plannerPredictedNoMatchTotal = plannerRows.filter((r) => r.predicted === 'no_match').length;
  const noMatchPrecision = { normal: normalNoMatchPred / Math.max(1, normalRows.filter((r) => r.returned.length === 0).length), planner: plannerNoMatchPred / Math.max(1, plannerPredictedNoMatchTotal) };
  const noMatchRecall = { normal: normalNoMatchPred / Math.max(1, noMatchCases.length), planner: plannerNoMatchPred / Math.max(1, noMatchCases.length) };

  const quotaChecks = plannerRows.flatMap((row) => {
    const evalCase = CASES.find((c) => c.id === row.id);
    if (!evalCase || evalCase.relevantKeys.length === 0) return [];
    return row.perSubquestion.map((sub) => (sub.recallAt5 >= 1 || sub.coverage === 'sufficient' ? 1 : 0));
  });
  const quotaSuccess = quotaChecks.length === 0 ? 1 : quotaChecks.reduce<number>((a, b) => a + b, 0) / quotaChecks.length;
  const backfillProbe = await (async (): Promise<number> => {
    const pool = CORPUS.map((doc, index) => ({
      id: doc.documentId * 10 + index,
      chunkUid: `uid-${doc.documentId}-0`,
      documentId: doc.documentId,
      fileName: 'synthetic.md',
      page: null,
      sectionTitle: doc.section,
      source: `docs/${doc.key}.md`,
      title: doc.title,
      content: doc.content,
      similarity: 0.9,
      parentChunkId: null,
      chunkIndex: 0,
    }));
    if (pool.length < 4) return 0;
    const seen = new Set(pool.slice(0, 2).map((item) => `chunk_uid:${item.chunkUid ?? `${item.documentId}:0`}`));
    const second = await runStructuredSearch(
      { search: deps },
      {
        originalQuery: 'password reset refund procedure guide',
        callId: 'eval-backfill-probe',
        requestedLimit: 2,
        signal: new AbortController().signal,
        excludeChunkIdentities: seen,
        budgets: { maxResultsPerSubquestion: 2 },
      },
    );
    const returned = second.sets.flatMap((set) => (set.kind === 'results' ? set.results : []));
    const unseen = returned.filter((item) => !seen.has(`chunk_uid:${item.chunkUid ?? `${item.documentId}:${item.chunkIndex}`}`));
    return unseen.length >= 2 ? 1 : 0;
  })();
  const backfillSuccess = backfillProbe;
  const dominantRetention = (() => {
    const dominant = Array.from({ length: 6 }, (_, index) => ({
      id: 100 + index,
      documentId: 1,
      fileName: 'd.md',
      page: null,
      sectionTitle: null,
      source: null,
      title: null,
      content: `Dominant ${index}`,
      chunkIndex: index,
      chunkUid: `dom-${index}`,
      scores: { dense: 0.99, finalRank: index + 1, finalSignal: 'dense' as const },
    }));
    const weak = [{
      id: 200,
      documentId: 2,
      fileName: 'w.md',
      page: null,
      sectionTitle: null,
      source: null,
      title: null,
      content: 'Weak',
      chunkIndex: 0,
      chunkUid: 'weak-0',
      scores: { dense: 0.6, finalRank: 1, finalSignal: 'dense' as const },
    }];
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: dominant as never, requestedCount: 3 },
        { subquestionId: 'sq-b', rankedResults: weak as never, requestedCount: 1 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 5,
      maxResultsPerSearchCall: 6,
    });
    const weakSet = packed.packedSets.find((set) => set.subquestionId === 'sq-b');
    return (weakSet?.results.length ?? 0) >= 1 ? 1 : 0;
  })();

  const ndcgRegression = Math.max(0, normalMetrics.ndcgAt10 - plannerMetrics.ndcgAt10);
  const docHit = (rows: { id: string; returned: number[] }[]): number => {
    const hits = answerable.filter((c) => {
      const expected = c.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1);
      const returned = rows.find((r) => r.id === c.id)?.returned ?? [];
      return expected.some((id) => returned.includes(id));
    });
    return answerable.length === 0 ? 1 : hits.length / answerable.length;
  };
  const docHitGate = { active: true, normal: docHit(normalRows), planner: docHit(plannerRows) };
  const perCategoryNdcg: Record<string, { normal: number; planner: number; regression: number }> = {};
  const singleIntentCategories = [...new Set(answerable.map((c) => c.category))]
    .filter((category) => category !== 'multi_concept')
    .sort();
  for (const category of singleIntentCategories) {
    const catCases = answerable.filter((c) => c.category === category);
    const catNdcg = (rows: { id: string; returned: number[] }[]): number =>
      mean(catCases.map((c) => {
        const expected = c.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1);
        return ndcg(rows.find((r) => r.id === c.id)?.returned ?? [], expected);
      }));
    const normal = catNdcg(normalRows);
    const planner = catNdcg(plannerRows);
    perCategoryNdcg[category] = { normal, planner, regression: Math.max(0, normal - planner) };
  }
  const gates = {
    recallAt5: { required: 0.9, normal: normalMetrics.recallAt5, planner: plannerMetrics.recallAt5, passed: normalMetrics.recallAt5 >= 0.9 && plannerMetrics.recallAt5 >= 0.9 },
    mrrAt10: { required: 0.8, normal: normalMetrics.mrrAt10, planner: plannerMetrics.mrrAt10, passed: normalMetrics.mrrAt10 >= 0.8 && plannerMetrics.mrrAt10 >= 0.8 },
    noMatchPrecision: { required: 0.95, ...noMatchPrecision, passed: noMatchPrecision.planner >= 0.95 && noMatchPrecision.normal >= 0.95 },
    noMatchRecall: { required: 0.9, ...noMatchRecall, passed: noMatchRecall.planner >= 0.9 && noMatchRecall.normal >= 0.9 },
    ndcgRegression: { maximum: 0.02, actual: ndcgRegression, passed: ndcgRegression <= 0.02 },
    docHitGate: { required: 0.8, ...docHitGate, passed: docHitGate.active && docHitGate.normal >= 0.8 && docHitGate.planner >= 0.8 },
    perCategoryNdcgRegression: {
      maximum: 0.02,
      note: 'Single-intent categories only; multi_concept compound quality is measured per subquestion (quota gate), because flattened cross-subquestion rankings are not comparable rankings (no global cross-intent rerank).',
      actual: perCategoryNdcg,
      passed: Object.values(perCategoryNdcg).every((entry) => entry.regression <= 0.02),
    },
    quota: { required: 1, actual: quotaSuccess, passed: quotaSuccess === 1 },
    backfill: { required: 1, actual: backfillSuccess, passed: backfillSuccess === 1 },
    dominantRetention: { required: 1, actual: dominantRetention, passed: dominantRetention === 1 },
  };

  const improves =
    plannerMetrics.recallAt5 > normalMetrics.recallAt5 ||
    plannerMetrics.mrrAt10 > normalMetrics.mrrAt10 ||
    plannerMetrics.ndcgAt10 > normalMetrics.ndcgAt10 ||
    plannerMetrics.recallAt1 > normalMetrics.recallAt1;
  const latencyP95Normal = percentile(normalRows.map((r) => r.latencyMs), 0.95);
  const latencyP95Planner = percentile(plannerRows.map((r) => r.latencyMs), 0.95);
  const latencyBreach = latencyP95Normal > 0 && (latencyP95Planner - latencyP95Normal) / latencyP95Normal > 0.15;
  const allGatesPassed = Object.values(gates).every((gate) => (gate as { passed: boolean }).passed);
  const decision = improves && !latencyBreach && allGatesPassed ? 'planner_accepted_shadow' : 'planner_rejected_keep_normal';

  const compound = compoundCases.map((c) => {
    const expected = c.relevantKeys.map((k) => CORPUS.find((d) => d.key === k)?.documentId ?? -1);
    const normalIds = normalRows.find((r) => r.id === c.id)?.returned ?? [];
    const plannerSubs = plannerRows.find((r) => r.id === c.id)?.perSubquestion ?? [];
    return {
      id: c.id,
      normalSingleListRecallAt5: recallAt(normalIds, expected, 5),
      plannerPerSubquestion: plannerSubs,
    };
  });
  const report = {
    schemaVersion: 'wp4-retrieval-report.v1',
    generatedAt: new Date().toISOString(),
    configSha256: configSha,
    config,
    aggregateScope: 'single-intent cases only; compound multi_concept cases are evaluated per subquestion (see compound section), because independently ranked subquestion lists must never be globally reranked into one synthetic ranking',
    normal: { metrics: normalMetrics, rows: normalRows, latencyP95: latencyP95Normal },
    planner: { metrics: plannerMetrics, rows: plannerRows, latencyP95: latencyP95Planner },
    compound,
    noMatch: { precision: noMatchPrecision, recall: noMatchRecall, plannerTypedStates: plannerRows.map((r) => ({ id: r.id, predicted: r.predicted, noMatchReasons: r.noMatchReasons })) },
    gates,
    decision,
    default: 'normal',
    limitations: ['Synthetic in-memory corpus only; no production data. WP-7 real-model/production-path gates not claimed.'],
  };
  mkdirSync('eval', { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ report: REPORT_PATH, decision, normalMetrics, plannerMetrics, gates }, null, 2));
  const failed = Object.values(gates).filter((gate) => !(gate as { passed: boolean }).passed);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : 'WP-4 retrieval evaluation failed');
  process.exitCode = 1;
});
