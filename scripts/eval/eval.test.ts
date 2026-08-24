import { describe, it, expect } from 'vitest';
import {
  evaluateOne,
  runEval,
  aggregate,
  buildGoldenReport,
  evalGateFailure,
  isDocHit,
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

describe('§C2 agentic mode + expectedDocIds hits', () => {
  it('routes mode=agentic questions through the agenticSearch dep', async () => {
    let agenticCalls = 0;
    let normalCalls = 0;
    const r = await evaluateOne(
      { id: 'ag1', question: 'What is the claim deadline?', mustMention: ['claim'], mode: 'agentic' },
      deps({
        searchChunks: async () => {
          normalCalls += 1;
          return [{ content: 'claim deadline text', documentId: 4 }];
        },
        agenticSearch: async () => {
          agenticCalls += 1;
          return [{ content: 'claim deadline text', documentId: 7 }];
        },
        generate: async () => 'the claim deadline is Friday',
      }),
    );
    expect(agenticCalls).toBe(1);
    expect(normalCalls).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('falls back to normal retrieval when the deps do not wire agenticSearch', async () => {
    let normalCalls = 0;
    const r = await evaluateOne(
      { id: 'ag2', question: 'q?', mustMention: [], mode: 'agentic' },
      deps({
        searchChunks: async () => {
          normalCalls += 1;
          return [{ content: 'ctx', documentId: 1 }];
        },
      }),
    );
    expect(normalCalls).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('isDocHit is any-overlap between retrieved and expected ids', () => {
    expect(isDocHit([3, 9], [9])).toBe(true);
    expect(isDocHit([3], [9])).toBe(false);
    expect(isDocHit([], [9])).toBe(false);
  });

  it('hit is true only on overlap with expectedDocIds, undefined when omitted', async () => {
    const hit = await evaluateOne(
      { id: 'h1', question: 'q?', mustMention: [], expectedDocIds: [5] },
      deps({ searchChunks: async () => [{ content: 'c', documentId: 5 }] }),
    );
    expect(hit.hit).toBe(true);

    const miss = await evaluateOne(
      { id: 'h2', question: 'q?', mustMention: [], expectedDocIds: [5] },
      deps({ searchChunks: async () => [{ content: 'c', documentId: 6 }] }),
    );
    expect(miss.hit).toBe(false);

    const unchecked = await evaluateOne(
      { id: 'h3', question: 'q?', mustMention: [] },
      deps({ searchChunks: async () => [{ content: 'c' }] }),
    );
    expect(unchecked.hit).toBeUndefined();
  });

  it('aggregate computes passRate over expectation-carrying questions only', () => {
    const base = {
      answer: '', retrievedCount: 0, refusalExpected: false, refused: false,
      faithfulness: 1, correctness: 1, contextRelevancy: 1,
      forbiddenHit: [], passed: true,
      judgedRetrievalRelevance: null, judgedFaithfulness: null,
    };
    const report = aggregate(
      [
        { ...base, hit: true },
        { ...base, hit: false },
        { ...base },
      ] as never[],
      0.7,
    );
    expect(report.hits).toBe(1);
    expect(report.passRate).toBeCloseTo(0.5, 5);
    expect(report.docHitGateActive).toBe(true);
  });

  it('passRate is 1 (vacuous) when no question sets expectedDocIds', async () => {
    const report = await runEval([{ id: 'x', question: 'q', mustMention: [] }], deps(), 0.7);
    expect(report.hits).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.docHitGateActive).toBe(false);
  });
});

describe('§C3 judge score plumbing', () => {
  it('carries judge scores through evaluateOne and averages non-null values', async () => {
    const r = await evaluateOne(
      { id: 'j1', question: 'dental?', mustMention: ['dental'] },
      deps({
        searchChunks: async () => [{ content: 'dental cleaning is covered' }],
        generate: async () => 'dental cleaning is covered',
        judgeRelevance: async () => 0.9,
        judgeFaithfulness: async () => 0.7,
      }),
    );
    expect(r.judgedRetrievalRelevance).toBe(0.9);
    expect(r.judgedFaithfulness).toBe(0.7);
  });

  it('judge nulls are excluded from the golden-report averages', () => {
    const base = {
      answer: '', retrievedCount: 0, refusalExpected: false, refused: false,
      faithfulness: 1, correctness: 1, contextRelevancy: 1,
      forbiddenHit: [], passed: true, hit: undefined,
    };
    const report = aggregate(
      [
        { ...base, judgedFaithfulness: 0.9, judgedRetrievalRelevance: null },
        { ...base, judgedFaithfulness: null, judgedRetrievalRelevance: 0.5 },
      ] as never[],
      0.7,
    );
    expect(report.avgFaithfulnessJudge).toBeCloseTo(0.9, 5);
    expect(report.avgRetrievalRelevanceJudge).toBeCloseTo(0.5, 5);
  });
});

describe('§C7 golden-report shape + gate', () => {
  it('buildGoldenReport emits the dashboard artifact shape', () => {
    const base = {
      answer: '', retrievedCount: 0, refusalExpected: false, refused: false,
      faithfulness: 1, correctness: 1, contextRelevancy: 1,
      forbiddenHit: [], passed: true, hit: undefined,
      judgedFaithfulness: null as number | null, judgedRetrievalRelevance: null as number | null,
    };
    const report = aggregate(
      [
        { ...base, judgedFaithfulness: 0.82 },
        { ...base, hit: true },
      ] as never[],
      0.7,
    );
    const golden = buildGoldenReport(report);
    expect(golden.total).toBe(2);
    expect(golden.hits).toBe(1);
    expect(golden.passRate).toBe(1);
    expect(golden.docHitGateActive).toBe(true);
    expect(golden.avgFaithfulness).toBeCloseTo(0.82, 5);
    expect(golden.avgRetrievalRelevance).toBeNull();
    expect(new Date(golden.generatedAt).toString()).not.toBe('Invalid Date');
  });

  it('buildGoldenReport marks the doc-hit gate inactive without expectations', () => {
    const base = {
      answer: '', retrievedCount: 0, refusalExpected: false, refused: false,
      faithfulness: 1, correctness: 1, contextRelevancy: 1,
      forbiddenHit: [], passed: true, hit: undefined,
      judgedFaithfulness: null as number | null, judgedRetrievalRelevance: null as number | null,
    };
    const report = aggregate([base] as never[], 0.7);
    const golden = buildGoldenReport(report);
    expect(golden.docHitGateActive).toBe(false);
    expect(golden.passRate).toBe(1);
  });

  it('evalGateFailure passes a healthy run and fails each gate independently', () => {
    const healthy = {
      results: [],
      meanFaithfulness: 0.95,
      meanCorrectness: 1,
      meanContextRelevancy: 1,
      passed: true,
      threshold: 0.7,
      hits: 9,
      passRate: 0.9,
      avgFaithfulnessJudge: 0.88,
      avgRetrievalRelevanceJudge: 0.8,
    };
    expect(evalGateFailure(healthy as never)).toBeNull();

    expect(evalGateFailure({ ...healthy, meanFaithfulness: 0.5 } as never)).toMatch(/mean faithfulness/);
    expect(evalGateFailure({ ...healthy, avgFaithfulnessJudge: 0.69 } as never)).toMatch(/judge faithfulness/);
    expect(evalGateFailure({ ...healthy, passRate: 0.79 } as never)).toMatch(/passRate/);
    expect(evalGateFailure({ ...healthy, avgFaithfulnessJudge: null } as never)).toBeNull();
  });
});