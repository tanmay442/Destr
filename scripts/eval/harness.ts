import type { AnswerCache } from '@app/domain';
import type { GoldenQuestion } from './golden';

export interface EvalDeps {
  searchChunks: (query: string) => Promise<Array<{ content: string; documentId?: number }>>;
  generate: (query: string, context: string) => Promise<string>;
  gradeFaithfulness: (documents: string, generation: string) => Promise<'yes' | 'no'>;
  
  judgeRelevance?: (question: string, snippets: string[]) => Promise<number | null>;
  judgeFaithfulness?: (documents: string, answer: string) => Promise<number | null>;
  
  agenticSearch?: (query: string) => Promise<Array<{ content: string; documentId?: number }>>;
}

export interface EvalResult {
  id: string;
  question: string;
  answer: string;
  retrievedCount: number;
  refusalExpected: boolean;
  refused: boolean;
  faithfulness: number;
  correctness: number;
  contextRelevancy: number;
  forbiddenHit: string[];
  passed: boolean;
  /** True when any retrieved doc id overlaps expectedDocIds; undefined when no expectation set. */
  hit?: boolean;
  
  judgedRetrievalRelevance: number | null;
  judgedFaithfulness: number | null;
}

const REFUSAL_PHRASES = [
  'cannot answer',
  "can't answer",
  'unable to answer',
  'not able to answer',
  "i don't know",
  'do not have',
  'no information',
];

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary, case-insensitive phrase match (no substring hits). */
export function matchesPhrase(haystack: string, phrase: string): boolean {
  const needle = phrase.trim();
  if (!needle) return false;
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(haystack);
}

export function matchedCount(text: string, phrases: string[]): number {
  return phrases.filter((p) => matchesPhrase(text, p)).length;
}

/** A generation that declines to answer from the given context. */
export function isRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_PHRASES.some((p) => lower.includes(p));
}

/** Requires ≥ 2 distinct (case-insensitive, non-empty) phrases. */
export function isDistinctPhrases(phrases: string[]): boolean {
  return new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean)).size >= 2;
}

export function isDocHit(actualDocIds: number[], expectedDocIds: number[]): boolean {
  const expected = new Set(expectedDocIds);
  return actualDocIds.some((id) => expected.has(id));
}

export async function evaluateOne(
  q: GoldenQuestion,
  deps: EvalDeps,
): Promise<EvalResult> {
  const useAgentic = q.mode === 'agentic' && typeof deps.agenticSearch === 'function';
  if (q.mode === 'agentic' && !useAgentic) {
    console.warn(`[eval] agentic question "${q.id}" degraded to plain searchChunks: agenticSearch unavailable`);
  }
  const retrieved = useAgentic
    ? await deps.agenticSearch!(q.question)
    : await deps.searchChunks(q.question);
  const context = retrieved.map((r) => r.content).join('\n\n');
  const answer = await deps.generate(q.question, context);
  const refusalExpected = q.refusalExpected ?? q.mustMention.length === 0;
  const refused = isRefusal(answer);

  let faithfulness = 0;
  if (refused) {
    faithfulness = refusalExpected ? 1 : 0;
  } else if (retrieved.length > 0) {
    faithfulness = (await deps.gradeFaithfulness(context, answer)) === 'yes' ? 1 : 0;
  }

  const judgedRetrievalRelevance =
    typeof deps.judgeRelevance === 'function'
      ? await deps.judgeRelevance(q.question, retrieved.map((r) => r.content))
      : null;
  const judgedFaithfulness =
    typeof deps.judgeFaithfulness === 'function'
      ? await deps.judgeFaithfulness(context, answer)
      : null;

  const actualDocIds = retrieved
    .map((r) => r.documentId)
    .filter((id): id is number => typeof id === 'number');
  const hit = q.expectedDocIds ? isDocHit(actualDocIds, q.expectedDocIds) : undefined;

  const correctness =
    q.mustMention.length === 0
      ? 1
      : matchedCount(answer, q.mustMention) / q.mustMention.length;
  const contextRelevancy =
    q.mustMention.length === 0
      ? 1
      : matchedCount(context, q.mustMention) / q.mustMention.length;
  const forbiddenHit = (q.forbidden ?? []).filter((p) =>
    matchesPhrase(answer, p),
  );

  return {
    id: q.id,
    question: q.question,
    answer,
    retrievedCount: retrieved.length,
    refusalExpected,
    refused,
    faithfulness,
    correctness,
    contextRelevancy,
    forbiddenHit,
    passed: faithfulness === 1 && forbiddenHit.length === 0 && correctness >= 0.5,
    ...(hit !== undefined ? { hit } : {}),
    judgedRetrievalRelevance,
    judgedFaithfulness,
  };
}

export interface EvalReport {
  results: EvalResult[];
  meanFaithfulness: number;
  meanCorrectness: number;
  meanContextRelevancy: number;
  passed: boolean;
  threshold: number;
  
  hits: number;
  passRate: number;
  /** False when no question set expectedDocIds — passRate is vacuous [F5]. */
  docHitGateActive: boolean;
  avgFaithfulnessJudge: number | null;
  avgRetrievalRelevanceJudge: number | null;
}

export async function runEval(
  questions: GoldenQuestion[],
  deps: EvalDeps,
  threshold: number,
): Promise<EvalReport> {
  const CONCURRENCY = 5;
  const results: EvalResult[] = [];
  for (let i = 0; i < questions.length; i += CONCURRENCY) {
    const batch = questions.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((q) => evaluateOne(q, deps)));
    results.push(...batchResults);
  }
  return { ...aggregate(results, threshold) };
}

function isValidThreshold(v: number): boolean {
  return Number.isFinite(v) && v > 0 && v <= 1;
}

export function aggregate(
  results: EvalResult[],
  threshold: number,
): EvalReport {
  if (!isValidThreshold(threshold)) {
    console.warn(`[eval] invalid threshold ${String(threshold)} — must be finite in (0,1]; treating as gate failure`);
  }
  const thresholdValid = isValidThreshold(threshold);
  const mean = (sel: (r: EvalResult) => number) =>
    results.length ? results.reduce((acc, r) => acc + sel(r), 0) / results.length : 0;
  const meanFaithfulness = mean((r) => r.faithfulness);
  const meanCorrectness = mean((r) => r.correctness);
  const meanContextRelevancy = mean((r) => r.contextRelevancy);

  const withExpectation = results.filter((r) => r.hit !== undefined);
  const hits = withExpectation.filter((r) => r.hit === true).length;
  const docHitGateActive = withExpectation.length > 0;

  const judgedFaithful = results
    .map((r) => r.judgedFaithfulness)
    .filter((v): v is number => v !== null);
  const judgedRelevant = results
    .map((r) => r.judgedRetrievalRelevance)
    .filter((v): v is number => v !== null);

  return {
    results,
    meanFaithfulness,
    meanCorrectness,
    meanContextRelevancy,
    passed: thresholdValid && meanFaithfulness >= threshold,
    threshold,
    hits,
    passRate: withExpectation.length > 0 ? hits / withExpectation.length : 1,
    docHitGateActive,
    avgFaithfulnessJudge:
      judgedFaithful.length > 0
        ? judgedFaithful.reduce((a, b) => a + b, 0) / judgedFaithful.length
        : null,
    avgRetrievalRelevanceJudge:
      judgedRelevant.length > 0
        ? judgedRelevant.reduce((a, b) => a + b, 0) / judgedRelevant.length
        : null,
  };
}

export interface GoldenReport {
  total: number;
  hits: number;
  passRate: number;
  /** False when no golden question defines expectedDocIds; passRate is vacuous. */
  docHitGateActive: boolean;
  avgFaithfulness: number | null;
  avgRetrievalRelevance: number | null;
  generatedAt: string;
}

export function buildGoldenReport(report: EvalReport): GoldenReport {
  return {
    total: report.results.length,
    hits: report.hits,
    passRate: report.passRate,
    docHitGateActive: report.docHitGateActive,
    avgFaithfulness: report.avgFaithfulnessJudge,
    avgRetrievalRelevance: report.avgRetrievalRelevanceJudge,
    generatedAt: new Date().toISOString(),
  };
}

export function evalGateFailure(report: EvalReport): string | null {
  if (!isValidThreshold(report.threshold)) {
    return `invalid threshold ${String(report.threshold)} — must be in (0,1]`;
  }
  if (!report.passed) {
    return `mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (report.meanFaithfulness < report.threshold) {
    return `mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (
    report.avgFaithfulnessJudge !== null &&
    report.avgFaithfulnessJudge < report.threshold
  ) {
    return `judge faithfulness ${report.avgFaithfulnessJudge.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (report.passRate < PASS_RATE_MIN) {
    return `passRate ${(report.passRate * 100).toFixed(0)}% < ${PASS_RATE_MIN * 100}%`;
  }
  return null;
}

const PASS_RATE_MIN = 0.8;

/** Mock deps for CI: deterministic, no network/DB. */
export function mockEvalDeps(): EvalDeps & { cache: AnswerCache } {
  const cacheStore = new Map<string, string>();
  const search = async (query: string) => {
    if (/password|dental|claim|dress|refund/i.test(query)) {
      return [{ content: `Relevant org doc about ${query}` }];
    }
    return [];
  };
  return {
    cache: {
      async get(key: string) {
        return cacheStore.get(key) ?? null;
      },
      async set(key: string, value: string) {
        cacheStore.set(key, value);
      },
    },
    async searchChunks(query: string) {
      return search(query);
    },
    async agenticSearch(query: string) {
      const base = await search(query);
      return base.map((r) => ({ ...r, content: `[agentic] ${r.content}` }));
    },
    async generate(_query: string, context: string) {
      return context
        ? `Based on the docs: ${context.slice(0, 80)}`
        : 'I cannot answer that from the available docs.';
    },
    async gradeFaithfulness(documents: string, generation: string) {
      return documents.trim() === '' || generation.trim() === '' ? 'no' : 'yes';
    },
  };
}
