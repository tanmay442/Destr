import { describe, it, expect } from 'vitest';
import {
  evaluateOne,
  runEval,
  aggregate,
  buildGoldenReport,
  evalGateFailure,
  isDocHit,
  isChunkHit,
  isRefusal,
  matchesPhrase,
  isDistinctPhrases,
  hasRequiredSignalsInContextAndAnswer,
  normalizeInterCaseDelayMs,
  REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS,
  mockEvalDeps,
  fingerprint,
  fingerprintUntrackedFiles,
  sanitizeIdentifier,
  type EvalDeps,
  type EvalMode,
  type EvalProgressEvent,
  type GoldenReportMetadata,
} from './harness';
import type { GoldenQuestion } from './golden';
import { goldenQuestions } from './golden';
import {
  searchSyntheticMockCorpus,
  syntheticMockCorpus,
  syntheticMockCorpusManifest,
  SYNTHETIC_MOCK_CORPUS_VERSION,
} from './mock-corpus';

function deps(overrides: Partial<EvalDeps> = {}): EvalDeps {
  return {
    searchChunks: async () => [],
    generate: async () => 'an answer',
    gradeFaithfulness: async () => 'yes',
    ...overrides,
  };
}

function reportMetadata(mode: EvalMode): GoldenReportMetadata {
  return {
    mode,
    baselineCommit: 'test-commit',
    candidateModelId: mode === 'mock' ? 'synthetic-mock-model' : 'synthetic-test-model',
    manifestIdentity: mode === 'real' ? 'live-corpus-unpinned' : SYNTHETIC_MOCK_CORPUS_VERSION,
    sourceFingerprint: fingerprint(['source', 'fixture-source-v1']),
    configFingerprint: fingerprint(['config', mode]),
    corpusFingerprint: fingerprint(['corpus', JSON.stringify(syntheticMockCorpusManifest)]),
    dirtyTreeFingerprint: fingerprint(['dirty-tree', 'clean']),
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

  it('keeps safe model ids readable and redacts arbitrary provider identifiers', () => {
    expect(sanitizeIdentifier('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
    const secretLike = 'https://provider.example/v1/models?api_key=secret-value';
    const sanitized = sanitizeIdentifier(secretLike);
    expect(sanitized).toMatch(/^redacted-[0-9a-f]{16}$/);
    expect(sanitized).not.toContain(secretLike);
  });
});

describe('evaluateOne — faithfulness', () => {
  it('grounds every required signal in both context and answer', () => {
    expect(hasRequiredSignalsInContextAndAnswer(
      ['refund', 'policy'],
      'The refund policy applies here.',
      'The refund policy applies.',
    )).toBe(true);
    expect(hasRequiredSignalsInContextAndAnswer(
      ['refund', 'policy'],
      'The refund policy applies here.',
      'The refund applies.',
    )).toBe(false);
    expect(hasRequiredSignalsInContextAndAnswer(
      ['refund', 'policy'],
      'The refund applies here.',
      'The refund policy applies.',
    )).toBe(false);
    expect(hasRequiredSignalsInContextAndAnswer([], 'unrelated context', 'confident answer')).toBe(false);
  });

  it('credits a refusal ONLY when a refusal is expected', async () => {
    const refusal = deps({
      searchChunks: async () => [],
      generate: async () => 'I cannot answer that from the available docs.',
    });
    const expected: GoldenQuestion = {
      id: 'q1',
      category: 'out_of_scope',
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

  it('captures monotonic retrieval, generation, and total timings', async () => {
    let tick = 0;
    const r = await evaluateOne(
      {
        id: 'timing-case',
        category: 'exact_term',
        question: 'What is the password reset procedure?',
        mustMention: ['password', 'reset'],
        expectedMockDocIds: [101],
        expectedMockChunkUids: ['chunk-synth-password-procedure'],
      },
      deps({
        clock: {
          now: () => {
            tick += 5;
            return tick;
          },
        },
        searchChunks: async () => [{
          content: 'password reset procedure',
          documentId: 101,
          documentUid: 'doc-synth-password-guide',
          chunkUid: 'chunk-synth-password-procedure',
        }],
        generate: async () => 'password reset procedure',
      }),
      'real_synthetic',
    );
    expect(r.retrievalMs).toBe(5);
    expect(r.generationMs).toBe(5);
    expect(r.totalMs).toBe(10);
    expect(r.hit).toBe(true);
    expect(r.chunkHit).toBe(true);
  });

  it('requires refusal behavior to match the golden expectation for every case', async () => {
    const refusalQuestions = goldenQuestions.filter((q) => q.refusalExpected === true);
    const answerableQuestions = goldenQuestions.filter((q) => q.refusalExpected !== true);
    expect(refusalQuestions.length).toBeGreaterThan(0);
    expect(answerableQuestions.length).toBeGreaterThan(0);

    for (const question of refusalQuestions) {
      const result = await evaluateOne(
        question,
        deps({
          searchChunks: async () => [{ content: 'neutral policy context' }],
          generate: async () => 'This is a neutral response.',
          gradeFaithfulness: async () => 'yes',
        }),
        'mock',
      );
      expect(result.refusalExpected, question.id).toBe(true);
      expect(result.refused, question.id).toBe(false);
      expect(result.faithfulness, question.id).toBe(1);
      expect(result.forbiddenHit, question.id).toEqual([]);
      expect(result.passed, question.id).toBe(false);
    }

    for (const question of answerableQuestions) {
      const answer = question.mustMention.join(' ');
      const expectedDocumentId = question.expectedMockDocIds?.[0];
      const expectedChunkUid = question.expectedMockChunkUids?.[0];
      const result = await evaluateOne(
        question,
        deps({
          searchChunks: async () => [{
            content: answer,
            ...(expectedDocumentId === undefined ? {} : { documentId: expectedDocumentId }),
            ...(expectedChunkUid === undefined ? {} : { chunkUid: expectedChunkUid }),
          }],
          generate: async () => 'I cannot answer that from the available docs.',
          gradeFaithfulness: async () => 'yes',
        }),
        'mock',
      );
      expect(result.refusalExpected, question.id).toBe(false);
      expect(result.refused, question.id).toBe(true);
      expect(result.faithfulness, question.id).toBe(0);
      expect(result.passed, question.id).toBe(false);
    }
  });

  it('does NOT auto-credit empty retrieval when the answer is not a refusal', async () => {
    const r = await evaluateOne(
      { id: 'q2', category: 'out_of_scope', question: 'Aspirin?', mustMention: [] },
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
      { id: 'q3', category: 'exact_term', question: 'What is the claim status?', mustMention: ['claim', 'status'] },
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
      { id: 'q4', category: 'exact_term', question: 'Dental?', mustMention: ['dental', 'cleaning'] },
      deps({
        searchChunks: async () => [{ content: 'dental cleaning is covered' }],
        generate: async () => 'dental cleaning is covered',
        gradeFaithfulness: async () => 'yes',
      }),
    );
    expect(faithful.faithfulness).toBe(1);

    const hallucinating = await evaluateOne(
      { id: 'q5', category: 'exact_term', question: 'Dental?', mustMention: ['dental', 'cleaning'] },
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
      { id: 'q6', category: 'out_of_scope', question: 'Itch?', mustMention: [], forbidden: ['medicine', 'doctor'] },
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
  it('bounds optional inter-case pacing without changing the mock default', () => {
    expect(normalizeInterCaseDelayMs(undefined)).toBe(0);
    expect(normalizeInterCaseDelayMs(-1)).toBe(0);
    expect(normalizeInterCaseDelayMs(250.9)).toBe(250);
    expect(normalizeInterCaseDelayMs(REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS + 1)).toBe(
      REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS,
    );
  });

  it('serializes real_synthetic generation once per case and omits every auxiliary judge', async () => {
    let generationCalls = 0;
    let activeGenerations = 0;
    let maxActiveGenerations = 0;
    let graderCalls = 0;
    let relevanceJudgeCalls = 0;
    let faithfulnessJudgeCalls = 0;

    const report = await runEval(
      goldenQuestions,
      deps({
        searchChunks: async () => [{ content: 'password reset dental claim dress refund policy' }],
        generate: async () => {
          activeGenerations += 1;
          maxActiveGenerations = Math.max(maxActiveGenerations, activeGenerations);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          generationCalls += 1;
          activeGenerations -= 1;
          return 'password reset';
        },
        gradeFaithfulness: async () => {
          graderCalls += 1;
          return 'no';
        },
        judgeRelevance: async () => {
          relevanceJudgeCalls += 1;
          return 0;
        },
        judgeFaithfulness: async () => {
          faithfulnessJudgeCalls += 1;
          return 0;
        },
      }),
      0.7,
      'real_synthetic',
      { interCaseDelayMs: 0 },
    );

    expect(report.results).toHaveLength(goldenQuestions.length);
    expect(generationCalls).toBe(goldenQuestions.length);
    expect(maxActiveGenerations).toBe(1);
    expect(graderCalls).toBe(0);
    expect(relevanceJudgeCalls).toBe(0);
    expect(faithfulnessJudgeCalls).toBe(0);
    expect(report.results.every((result) =>
      result.judgedRetrievalRelevance === null && result.judgedFaithfulness === null,
    )).toBe(true);
  });

  it('fails closed when candidate generation fails', async () => {
    let attempts = 0;
    const run = runEval(
      [{ id: 'provider-failure', category: 'exact_term', question: 'q', mustMention: ['answer'] }],
      deps({
        searchChunks: async () => [{ content: 'answer' }],
        generate: async () => {
          attempts += 1;
          throw new Error('provider request failed');
        },
      }),
      0.7,
      'real_synthetic',
      { interCaseDelayMs: 0, maxAttempts: 2, retryDelayMs: 0 },
    );
    await expect(run).rejects.toThrow(/bounded provider retries/u);
    expect(attempts).toBe(2);
  });

  it('recovers from a transient provider failure within the bounded retry budget', async () => {
    let attempts = 0;
    const progress: EvalProgressEvent[] = [];
    const report = await runEval(
      [{ id: 'provider-retry', category: 'exact_term', question: 'q', mustMention: ['answer'] }],
      deps({
        searchChunks: async () => [{ content: 'answer' }],
        generate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary provider request failure');
          return 'answer';
        },
      }),
      0.7,
      'real_synthetic',
      {
        interCaseDelayMs: 0,
        maxAttempts: 3,
        retryDelayMs: 0,
        onProgress: (event) => progress.push(event),
      },
    );
    expect(attempts).toBe(2);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[0]?.totalMs).toBeGreaterThanOrEqual(report.results[0]?.generationMs ?? 0);
    expect(progress.map((event) => event.kind)).toEqual([
      'attempt_started',
      'attempt_failed',
      'attempt_started',
      'case_completed',
    ]);
    expect(progress.at(-1)).toMatchObject({ attempts: 2, caseId: 'provider-retry' });
  });

  it('fails faithfulness when a real_synthetic answer or context omits a required signal', async () => {
    const question: GoldenQuestion = {
      id: 'signal-grounding',
      category: 'exact_term',
      question: 'What is the refund policy?',
      mustMention: ['refund', 'policy'],
      expectedMockDocIds: [105],
    };
    const answerMissingSignal = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{ content: 'The refund policy applies.' }],
        generate: async () => 'The refund applies.',
        gradeFaithfulness: async () => 'yes',
      }),
      'real_synthetic',
    );
    expect(answerMissingSignal.faithfulness).toBe(0);
    expect(answerMissingSignal.passed).toBe(false);

    const contextMissingSignal = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{ content: 'The refund applies.' }],
        generate: async () => 'The refund policy applies.',
        gradeFaithfulness: async () => 'yes',
      }),
      'real_synthetic',
    );
    expect(contextMissingSignal.faithfulness).toBe(0);
    expect(contextMissingSignal.passed).toBe(false);
  });

  it('keeps empty-signal real_synthetic cases governed only by refusal consistency', async () => {
    const question: GoldenQuestion = {
      id: 'empty-signal-refusal',
      category: 'out_of_scope',
      question: 'Should I take aspirin?',
      mustMention: [],
      forbidden: ['aspirin'],
      refusalExpected: true,
    };
    const refusal = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{ content: 'unrelated context' }],
        generate: async () => 'I cannot answer from the available docs.',
      }),
      'real_synthetic',
    );
    expect(refusal.faithfulness).toBe(1);
    expect(refusal.passed).toBe(true);

    const nonRefusal = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{ content: 'unrelated context' }],
        generate: async () => 'A confident answer.',
      }),
      'real_synthetic',
    );
    expect(nonRefusal.faithfulness).toBe(0);
    expect(nonRefusal.passed).toBe(false);
  });

  it('aggregates mean faithfulness and passes at threshold', async () => {
    const report = await runEval(
      [
        { id: 'a', category: 'exact_term', question: 'q', mustMention: ['one', 'two'] },
        { id: 'b', category: 'out_of_scope', question: 'q2', mustMention: [] },
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
    const report = await runEval(goldenQuestions, mockEvalDeps(), 0.7, 'mock');
    expect(report.meanFaithfulness).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.docHitGateActive).toBe(true);
    expect(report.passRate).toBe(1);
  });

  it('uses synthetic labels in real_synthetic mode while keeping the document gate active', async () => {
    const report = await runEval(goldenQuestions, mockEvalDeps(), 0.7, 'real_synthetic');
    expect(report.docHitGateActive).toBe(true);
    expect(report.passRate).toBe(1);
    expect(report.latency.totalMs.sampleCount).toBe(goldenQuestions.length);
  });
});

describe('synthetic mock corpus integrity', () => {
  it('has unique stable identities and explicit distractor records', () => {
    const documentIds = syntheticMockCorpus.map((record) => record.documentId);
    const documentUids = syntheticMockCorpus.map((record) => record.documentUid);
    const chunkUids = syntheticMockCorpus.map((record) => record.chunkUid);
    const documentChunkKeys = syntheticMockCorpus.map((record) => `${record.documentUid}:${record.chunkUid}`);

    expect(documentIds.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
    expect(new Set(documentChunkKeys).size).toBe(documentChunkKeys.length);
    expect(new Set(chunkUids).size).toBe(chunkUids.length);
    expect(new Set(documentUids).size).toBeLessThan(documentUids.length);
    expect(syntheticMockCorpus.length).toBeGreaterThan(5);
    expect(syntheticMockCorpusManifest.version).toBe(SYNTHETIC_MOCK_CORPUS_VERSION);
    expect(syntheticMockCorpus.filter((record) => record.kind === 'distractor').length).toBeGreaterThanOrEqual(2);
    expect(syntheticMockCorpus.every((record) => /^doc-synth-[a-z0-9-]+$/.test(record.documentUid))).toBe(true);
    expect(syntheticMockCorpus.every((record) => /^chunk-synth-[a-z0-9-]+$/.test(record.chunkUid))).toBe(true);
  });

  it('has a corpus record for every explicit mock document and chunk label', () => {
    const documentIds = new Set(syntheticMockCorpus.map((record) => record.documentId));
    const chunkUids = new Set(syntheticMockCorpus.map((record) => record.chunkUid));
    const answerable = goldenQuestions.filter((candidate) => candidate.refusalExpected !== true);

    for (const question of answerable) {
      for (const documentId of question.expectedMockDocIds ?? []) {
        expect(documentIds.has(documentId), question.id).toBe(true);
      }
      for (const chunkUid of question.expectedMockChunkUids ?? []) {
        expect(chunkUids.has(chunkUid), question.id).toBe(true);
      }
    }
  });

  it('contains every required answer signal in the expected synthetic context', () => {
    const answerable = goldenQuestions.filter((candidate) => candidate.refusalExpected !== true);
    for (const question of answerable) {
      const expectedDocumentIds = new Set(question.expectedMockDocIds ?? []);
      const context = syntheticMockCorpus
        .filter((record) => expectedDocumentIds.has(record.documentId))
        .map((record) => record.content)
        .join('\n\n');
      for (const signal of question.mustMention) {
        expect(matchesPhrase(context, signal), `${question.id}: ${signal}`).toBe(true);
      }
    }
  });

  it('searches corpus content and can return relevant records alongside distractors', async () => {
    const rows = await searchSyntheticMockCorpus('How do I reset my password?');
    expect(rows.some((record) => record.documentId === 101)).toBe(true);
    expect(rows.some((record) => record.documentId >= 106)).toBe(true);
    expect(rows.every((record) => syntheticMockCorpus.includes(record))).toBe(true);
  });

  it('changes provenance fingerprints when corpus, source, or dirtiness changes', () => {
    const corpus = JSON.stringify(syntheticMockCorpusManifest);
    expect(fingerprint(['corpus', corpus])).not.toBe(
      fingerprint(['corpus', corpus.replace(SYNTHETIC_MOCK_CORPUS_VERSION, `${SYNTHETIC_MOCK_CORPUS_VERSION}-changed`)]),
    );
    expect(fingerprint(['source', 'blob-a'])).not.toBe(fingerprint(['source', 'blob-b']));
    expect(fingerprint(['dirty-tree', 'clean'])).not.toBe(fingerprint(['dirty-tree', ' M scripts/eval/harness.ts']));
  });

  it('includes untracked file content hashes without serializing their contents', () => {
    const first = fingerprintUntrackedFiles([{
      path: 'scripts/eval/synthetic-note.txt',
      contentHash: fingerprint(['content-v1']),
    }]);
    const changed = fingerprintUntrackedFiles([{
      path: 'scripts/eval/synthetic-note.txt',
      contentHash: fingerprint(['content-v2']),
    }]);
    expect(first).not.toBe(changed);
    expect(first).not.toContain('content-v1');
    expect(changed).not.toContain('content-v2');
  });

  it('supports stable chunk-hit checks independently of document IDs', () => {
    expect(isChunkHit(['chunk-synth-password-procedure'], ['chunk-synth-password-procedure'])).toBe(true);
    expect(isChunkHit(['chunk-synth-navigation-distractor'], ['chunk-synth-password-procedure'])).toBe(false);
  });

  it('records a document-hit miss when a mock retrieval is mutated away from its labels', async () => {
    const question = goldenQuestions.find((candidate) => candidate.id === 'password-reset');
    expect(question).toBeDefined();
    if (question === undefined) return;

    const result = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{
          content: 'Synthetic unrelated record with no password procedure.',
          documentId: 999,
          documentUid: 'doc-synth-mutated',
          chunkUid: 'chunk-synth-mutated',
        }],
      }),
      'mock',
    );
    expect(result.hit).toBe(false);

    const report = aggregate([result], 0.7);
    expect(report.docHitGateActive).toBe(true);
    expect(report.passRate).toBe(0);
    expect(evalGateFailure(report)).toMatch(/passRate/);
  });

  it('keeps mock labels separate and makes real mode fail closed without real labels', async () => {
    const question = goldenQuestions.find((candidate) => candidate.id === 'password-reset');
    expect(question).toBeDefined();
    if (question === undefined) return;

    const result = await evaluateOne(
      question,
      deps({
        searchChunks: async () => [{ content: 'password reset procedure', documentId: 101 }],
        generate: async () => 'password reset procedure',
      }),
      'real',
    );
    expect(result.hit).toBeUndefined();

    const report = aggregate([result], 0.7);
    expect(report.docHitGateActive).toBe(false);
    expect(evalGateFailure(report)).toMatch(/document-hit gate is inactive/);
  });
});

describe('§C2 agentic mode + expectedDocIds hits', () => {
  it('routes mode=agentic questions through the agenticSearch dep', async () => {
    let agenticCalls = 0;
    let normalCalls = 0;
    const r = await evaluateOne(
      { id: 'ag1', category: 'semantic_paraphrase', question: 'What is the claim deadline?', mustMention: ['claim'], mode: 'agentic' },
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
      {
        id: 'ag2',
        category: 'semantic_paraphrase',
        question: 'q?',
        mustMention: [],
        refusalExpected: false,
        mode: 'agentic',
      },
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
      { id: 'h1', category: 'exact_term', question: 'q?', mustMention: [], expectedDocIds: [5] },
      deps({ searchChunks: async () => [{ content: 'c', documentId: 5 }] }),
    );
    expect(hit.hit).toBe(true);

    const miss = await evaluateOne(
      { id: 'h2', category: 'exact_term', question: 'q?', mustMention: [], expectedDocIds: [5] },
      deps({ searchChunks: async () => [{ content: 'c', documentId: 6 }] }),
    );
    expect(miss.hit).toBe(false);

    const unchecked = await evaluateOne(
      { id: 'h3', category: 'exact_term', question: 'q?', mustMention: [] },
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
    const report = await runEval([{ id: 'x', category: 'exact_term', question: 'q', mustMention: [] }], deps(), 0.7);
    expect(report.hits).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.docHitGateActive).toBe(false);
  });
});

describe('§C3 judge score plumbing', () => {
  it('carries judge scores through evaluateOne and averages non-null values', async () => {
    const r = await evaluateOne(
      { id: 'j1', category: 'exact_term', question: 'dental?', mustMention: ['dental'] },
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

  it('aggregates deterministic p50/p95/p99 latency percentiles with scope and units', () => {
    const base = {
      answer: '', retrievedCount: 0, refusalExpected: false, refused: false,
      faithfulness: 1, correctness: 1, contextRelevancy: 1,
      forbiddenHit: [], passed: true, hit: undefined,
      judgedFaithfulness: null, judgedRetrievalRelevance: null,
    };
    const report = aggregate(
      [
        { ...base, retrievalMs: 10, generationMs: 20, totalMs: 30 },
        { ...base, retrievalMs: 20, generationMs: 30, totalMs: 40 },
        { ...base, retrievalMs: 30, generationMs: 40, totalMs: 50 },
        { ...base, retrievalMs: 40, generationMs: 50, totalMs: 60 },
      ] as never[],
      0.7,
    );
    expect(report.latency.retrievalMs).toMatchObject({
      scope: 'all_cases',
      unit: 'milliseconds',
      sampleCount: 4,
      p50: 25,
      p95: 38.5,
      p99: 39.7,
    });
    expect(report.latency.totalMs.sampleCount).toBe(4);
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
    const golden = buildGoldenReport(report, reportMetadata('mock'));
    expect(golden.schemaVersion).toBe('golden-report.v1');
    expect(golden.mode).toBe('mock');
    expect(golden.baselineCommit).toBe('test-commit');
    expect(golden.candidateModelId).toBe('synthetic-mock-model');
    expect(golden.manifestIdentity).toBe(SYNTHETIC_MOCK_CORPUS_VERSION);
    expect(golden.sourceFingerprint).toMatch(/^sha256:/);
    expect(golden.configFingerprint).toMatch(/^sha256:/);
    expect(golden.corpusFingerprint).toMatch(/^sha256:/);
    expect(golden.dirtyTreeFingerprint).toMatch(/^sha256:/);
    expect(golden.total).toBe(2);
    expect(golden.hits).toBe(1);
    expect(golden.passRate).toBe(1);
    expect(golden.docHitGateActive).toBe(true);
    expect(golden.avgFaithfulness).toBeCloseTo(0.82, 5);
    expect(golden.avgRetrievalRelevance).toBeNull();
    expect(golden.meanFaithfulness).toBe(1);
    expect(golden.meanCorrectness).toBe(1);
    expect(golden.meanContextRelevancy).toBe(1);
    expect(golden.threshold).toBe(0.7);
    expect(golden.passed).toBe(true);
    expect(golden.latency.totalMs.scope).toBe('all_cases');
    expect(golden.latency.totalMs.unit).toBe('milliseconds');
    expect(golden.latency.totalMs.sampleCount).toBe(0);
    expect(golden.modelUsage.status).toBe('unavailable');
    expect(golden.modelUsage.inputTokens).toBeNull();
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
    const golden = buildGoldenReport(report, reportMetadata('real'));
    expect(golden.schemaVersion).toBe('golden-report.v1');
    expect(golden.mode).toBe('real');
    expect(golden.baselineCommit).toBe('test-commit');
    expect(golden.manifestIdentity).toBe('live-corpus-unpinned');
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
      docHitGateActive: true,
      avgFaithfulnessJudge: 0.88,
      avgRetrievalRelevanceJudge: 0.8,
    };
    expect(evalGateFailure(healthy as never)).toBeNull();

    expect(evalGateFailure({ ...healthy, meanFaithfulness: 0.5 } as never)).toMatch(/mean faithfulness/);
    expect(evalGateFailure({ ...healthy, avgFaithfulnessJudge: 0.69 } as never)).toMatch(/judge faithfulness/);
    expect(evalGateFailure({ ...healthy, passRate: 0.79 } as never)).toMatch(/passRate/);
    expect(evalGateFailure({ ...healthy, docHitGateActive: false } as never)).toMatch(/document-hit gate is inactive/);
    expect(evalGateFailure({ ...healthy, avgFaithfulnessJudge: null } as never)).toBeNull();
  });
});
