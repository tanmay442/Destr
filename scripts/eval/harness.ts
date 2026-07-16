/**
 * Evaluation harness logic (Session 10) — pure, provider-agnostic.
 *
 * Given a golden question, the harness:
 *   1. retrieves context via `searchChunks`,
 *   2. generates an answer via `generate`,
 *   3. scores three 0–1 metrics:
 *        - faithfulness : hallucination grader (`'yes'` ⇒ 1, `'no'` ⇒ 0)
 *        - correctness  : fraction of `mustMention` phrases present in the answer
 *        - contextRelevancy: fraction of `mustMention` phrases present in the
 *          retrieved context (did retrieval bring the right chunks?)
 *
 * All I/O is injected so the harness can run against mocks in CI (no real LLM /
 * DB) and against a keyed provider in a manual job.
 */
import type { AnswerCache } from '@app/domain';
import type { GoldenQuestion } from './golden';

export interface EvalDeps {
  searchChunks: (query: string) => Promise<Array<{ content: string }>>;
  generate: (query: string, context: string) => Promise<string>;
  gradeFaithfulness: (documents: string, generation: string) => Promise<'yes' | 'no'>;
}

export interface EvalResult {
  id: string;
  question: string;
  answer: string;
  retrievedCount: number;
  faithfulness: number;
  correctness: number;
  contextRelevancy: number;
  forbiddenHit: string[];
  passed: boolean;
}

function lowerContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export async function evaluateOne(q: GoldenQuestion, deps: EvalDeps): Promise<EvalResult> {
  const retrieved = await deps.searchChunks(q.question);
  const context = retrieved.map((r) => r.content).join('\n\n');
  const answer = await deps.generate(q.question, context);

  let faithfulness = 0;
  if (retrieved.length > 0) {
    faithfulness = (await deps.gradeFaithfulness(context, answer)) === 'yes' ? 1 : 0;
  } else {
    // No context ⇒ the question is (correctly) out-of-domain; faithfulness N/A.
    faithfulness = 1;
  }

  const correctHits = q.mustMention.filter((phrase) => lowerContains(answer, phrase)).length;
  const correctness = q.mustMention.length === 0 ? 1 : correctHits / q.mustMention.length;

  const relevantHits = q.mustMention.filter((phrase) => lowerContains(context, phrase)).length;
  const contextRelevancy = q.mustMention.length === 0 ? 1 : relevantHits / q.mustMention.length;

  const forbiddenHit = (q.forbidden ?? []).filter((phrase) => lowerContains(answer, phrase));

  return {
    id: q.id,
    question: q.question,
    answer,
    retrievedCount: retrieved.length,
    faithfulness,
    correctness,
    contextRelevancy,
    forbiddenHit,
    passed: faithfulness === 1 && forbiddenHit.length === 0 && correctness >= 0.5,
  };
}

export interface EvalReport {
  results: EvalResult[];
  meanFaithfulness: number;
  meanCorrectness: number;
  meanContextRelevancy: number;
  passed: boolean;
  threshold: number;
}

export async function runEval(
  questions: GoldenQuestion[],
  deps: EvalDeps,
  threshold: number,
): Promise<EvalReport> {
  const results = await Promise.all(questions.map((q) => evaluateOne(q, deps)));
  const mean = (sel: (r: EvalResult) => number) =>
    results.length ? results.reduce((acc, r) => acc + sel(r), 0) / results.length : 0;
  const meanFaithfulness = mean((r) => r.faithfulness);
  const meanCorrectness = mean((r) => r.correctness);
  const meanContextRelevancy = mean((r) => r.contextRelevancy);
  return {
    results,
    meanFaithfulness,
    meanCorrectness,
    meanContextRelevancy,
    threshold,
    passed: meanFaithfulness >= threshold,
  };
}

/** Mock deps for CI: deterministic, no network/DB. */
export function mockEvalDeps(): EvalDeps & { cache: AnswerCache } {
  const cacheStore = new Map<string, string>();
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
      if (/password|dental|claim|dress|refund/i.test(query)) {
        return [{ content: `Relevant org doc about ${query}` }];
      }
      return [];
    },
    async generate(_query: string, context: string) {
      return context ? `Based on the docs: ${context.slice(0, 80)}` : 'I cannot answer that from the available docs.';
    },
    async gradeFaithfulness(_documents: string, generation: string) {
      return generation.toLowerCase().includes('cannot answer') ? 'no' : 'yes';
    },
  };
}
