import { describe, it, expect } from 'vitest';
import {
  evaluateOne,
  runEval,
  isRefusal,
  matchesPhrase,
  isDistinctPhrases,
  mockEvalDeps,
  type EvalDeps,
} from './harness';
import type { GoldenQuestion } from './golden';
import { goldenQuestions } from './golden';

function deps(overrides: Partial<EvalDeps> = {}): EvalDeps {
  return {
    searchChunks: async () => [],
    generate: async () => 'an answer',
    gradeFaithfulness: async () => 'yes',
    ...overrides,
  };
}

describe('isRefusal / matchesPhrase / isDistinctPhrases', () => {
  it('detects a refusal', () => {
    expect(isRefusal('I cannot answer that from the available docs.')).toBe(true);
    expect(isRefusal('I do not have that information.')).toBe(true);
    expect(isRefusal('The refund policy is 30 days.')).toBe(false);
  });

  it('matches at word boundaries, not as substrings', () => {
    expect(matchesPhrase('please process my refund now', 'refund')).toBe(true);
    expect(matchesPhrase('the package is refunding soon', 'refund')).toBe(false);
    expect(matchesPhrase('cleaning is covered', 'dental')).toBe(false);
  });

  it('requires ≥ 2 distinct phrases for a grounded golden', () => {
    expect(isDistinctPhrases(['password', 'reset'])).toBe(true);
    expect(isDistinctPhrases(['dental', 'dental'])).toBe(false);
    expect(isDistinctPhrases(['refund'])).toBe(false);
  });
});

describe('evaluateOne — faithfulness', () => {
  it('credits a refusal ONLY when a refusal is expected', async () => {
    const refusal = deps({
      searchChunks: async () => [],
      generate: async () => 'I cannot answer that from the available docs.',
    });
    const expected: GoldenQuestion = {
      id: 'q1',
      question: 'Aspirin?',
      mustMention: [],
      forbidden: ['aspirin'],
      refusalExpected: true,
    };
    const r = await evaluateOne(expected, refusal);
    expect(r.refused).toBe(true);
    expect(r.faithfulness).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('does NOT auto-credit empty retrieval when the answer is not a refusal', async () => {
    const r = await evaluateOne(
      { id: 'q2', question: 'Aspirin?', mustMention: [] },
      deps({
        searchChunks: async () => [],
        generate: async () => 'You should take aspirin daily.',
      }),
    );
    expect(r.retrievedCount).toBe(0);
    expect(r.refused).toBe(false);
    expect(r.faithfulness).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('penalises a refusal when the question should have been answered', async () => {
    const r = await evaluateOne(
      { id: 'q3', question: 'What is the claim status?', mustMention: ['claim', 'status'] },
      deps({
        searchChunks: async () => [{ content: 'your claim status is under review' }],
        generate: async () => 'I cannot answer that from the available docs.',
      }),
    );
    expect(r.refused).toBe(true);
    expect(r.faithfulness).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('uses the hallucination grader when grounded and not refusing', async () => {
    const faithful = await evaluateOne(
      { id: 'q4', question: 'Dental?', mustMention: ['dental', 'cleaning'] },
      deps({
        searchChunks: async () => [{ content: 'dental cleaning is covered' }],
        generate: async () => 'dental cleaning is covered',
        gradeFaithfulness: async () => 'yes',
      }),
    );
    expect(faithful.faithfulness).toBe(1);

    const hallucinating = await evaluateOne(
      { id: 'q5', question: 'Dental?', mustMention: ['dental', 'cleaning'] },
      deps({
        searchChunks: async () => [{ content: 'dental cleaning is covered' }],
        generate: async () => 'dental cleaning covers implants',
        gradeFaithfulness: async () => 'no',
      }),
    );
    expect(hallucinating.faithfulness).toBe(0);
    expect(hallucinating.passed).toBe(false);
  });

  it('flags forbidden phrases via word-boundary matching', async () => {
    const r = await evaluateOne(
      { id: 'q6', question: 'Itch?', mustMention: [], forbidden: ['medicine', 'doctor'] },
      deps({
        searchChunks: async () => [],
        generate: async () => 'I cannot answer; take no medicine',
        gradeFaithfulness: async () => 'yes',
      }),
    );
    expect(r.forbiddenHit).toContain('medicine');
    expect(r.passed).toBe(false);
  });
});

describe('runEval', () => {
  it('aggregates mean faithfulness and passes at threshold', async () => {
    const report = await runEval(
      [
        { id: 'a', question: 'q', mustMention: ['one', 'two'] },
        { id: 'b', question: 'q2', mustMention: [] },
      ],
      deps({
        searchChunks: async () => [{ content: 'one two in docs' }],
        generate: async () => 'one two in docs',
      }),
      0.8,
    );
    expect(report.meanFaithfulness).toBe(1);
    expect(report.passed).toBe(true);
  });

  it('keeps the CI mock pass over the shipped golden set', async () => {
    const report = await runEval(goldenQuestions, mockEvalDeps(), 0.7);
    expect(report.meanFaithfulness).toBe(1);
    expect(report.passed).toBe(true);
  });
});