import { describe, it, expect } from 'vitest';
import { goldenQuestions } from './golden';
import { isDistinctPhrases } from './harness';

describe('golden question quality', () => {
  it('has unique ids', () => {
    const ids = goldenQuestions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
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
});