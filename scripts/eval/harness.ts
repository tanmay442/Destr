import type { AnswerCache } from '@app/domain';
import type { GoldenQuestion } from './golden';

/** Pure, provider-agnostic eval logic. Scores each question on three 0–1
 *  metrics: faithfulness (hallucination grader), correctness (mustMention
 *  recall), and contextRelevancy (mustMention present in retrieved context). */
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
  refusalExpected: boolean;
  refused: boolean;
  faithfulness: number;
  correctness: number;
  contextRelevancy: number;
  forbiddenHit: string[];
  passed: boolean;
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

export async function evaluateOne(
  q: GoldenQuestion,
  deps: EvalDeps,
): Promise<EvalResult> {
  const retrieved = await deps.searchChunks(q.question);
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
      return context
        ? `Based on the docs: ${context.slice(0, 80)}`
        : 'I cannot answer that from the available docs.';
    },
    async gradeFaithfulness(documents: string, generation: string) {
      return documents.trim() === '' || generation.trim() === '' ? 'no' : 'yes';
    },
  };
}
