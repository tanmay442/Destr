import { describe, it, expect } from 'vitest';
import { goldenQuestions } from './golden';
import { isDistinctPhrases } from './harness';
import {
  syntheticMockCorpusManifest,
  validateSyntheticMockLabelMembership,
} from './mock-corpus';

describe('golden question quality', () => {
  it('has unique ids', () => {
    const ids = goldenQuestions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has an explicit stable category', () => {
    for (const q of goldenQuestions) {
      expect(['exact_term', 'semantic_paraphrase', 'out_of_scope']).toContain(q.category);
    }
  });

  it('every grounded golden carries ≥ 2 distinct mustMention phrases', () => {
    for (const q of goldenQuestions) {
      if (q.mustMention.length === 0) continue;
      expect(
        isDistinctPhrases(q.mustMention),
        `${q.id} must carry >= 2 distinct mustMention phrases`,
      ).toBe(true);
    }
  });

  it('every out-of-scope golden expects a refusal and lists forbidden phrases', () => {
    for (const q of goldenQuestions) {
      if (q.mustMention.length > 0) continue;
      expect(q.refusalExpected, `${q.id} must set refusalExpected: true`).toBe(true);
      expect(
        (q.forbidden ?? []).length > 0,
        `${q.id} must list forbidden phrases`,
      ).toBe(true);
    }
  });

  it('grounded goldens never expect a refusal', () => {
    for (const q of goldenQuestions) {
      if (q.mustMention.length === 0) continue;
      expect(q.refusalExpected).not.toBe(true);
    }
  });

  it('§C2 additions carry modes, refusal coverage, and explicit mock labels', () => {
    for (const q of goldenQuestions) {
      if (q.mode !== undefined) {
        expect(['agentic', 'normal']).toContain(q.mode);
      }
      if (q.expectedMockDocIds !== undefined) {
        expect(q.expectedMockDocIds.length).toBeGreaterThan(0);
        expect(q.expectedMockDocIds.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
      }
      if (q.expectedMockChunkUids !== undefined) {
        expect(q.expectedMockChunkUids.length).toBeGreaterThan(0);
        expect(q.expectedMockChunkUids.every((uid) => /^chunk-synth-[a-z0-9-]+$/.test(uid))).toBe(true);
      }
    }
    const refusals = goldenQuestions.filter((q) => q.refusalExpected === true);
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    const nonsense = refusals.filter((q) => q.id.startsWith('nonsense-'));
    expect(nonsense.length).toBeGreaterThanOrEqual(3);
  });

  it('WP-0 activates document-hit labels for every answerable retrieval case', () => {
    const withExpectations = goldenQuestions.filter((q) => (q.expectedMockDocIds ?? []).length > 0);
    const answerable = goldenQuestions.filter((q) => q.refusalExpected !== true);
    expect(withExpectations.map((q) => q.id)).toEqual(answerable.map((q) => q.id));
    expect(answerable.every((q) => (q.expectedMockChunkUids ?? []).length > 0)).toBe(true);
  });

  it('validates every expected synthetic chunk belongs to its expected document', () => {
    expect(() => validateSyntheticMockLabelMembership(goldenQuestions)).not.toThrow();

    const mismatched = goldenQuestions.map((question) =>
      question.id === 'password-reset'
        ? {
            ...question,
            expectedMockDocIds: [102],
          }
        : question,
    );
    expect(() => validateSyntheticMockLabelMembership(mismatched)).toThrow(
      /synthetic chunk .* belongs to document 101/,
    );
    expect(syntheticMockCorpusManifest.records).toContainEqual(
      expect.objectContaining({
        chunkUid: 'chunk-synth-password-procedure',
        documentId: 101,
      }),
    );
  });

  it('keeps live-corpus labels absent so real evaluation fails closed', () => {
    expect(goldenQuestions.every((q) => q.expectedDocIds === undefined)).toBe(true);
  });
});
