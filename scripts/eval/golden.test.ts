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

  it('§C2 additions carry modes, refusal coverage, and no stray expectedDocIds in mock', () => {
    // Some questions opt into the agentic branch with a valid mode only.
    for (const q of goldenQuestions) {
      if (q.mode !== undefined) {
        expect(['agentic', 'normal']).toContain(q.mode);
      }
      if (q.expectedDocIds !== undefined) {
        expect(q.expectedDocIds.length).toBeGreaterThan(0);
      }
    }
    // At least 5 out-of-scope refusal cases and at least 3 nonsense-empty cases.
    const refusals = goldenQuestions.filter((q) => q.refusalExpected === true);
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    const nonsense = refusals.filter((q) => q.id.startsWith('nonsense-'));
    expect(nonsense.length).toBeGreaterThanOrEqual(3);
  });
});