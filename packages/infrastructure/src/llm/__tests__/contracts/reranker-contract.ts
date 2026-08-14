import { describe, it, expect } from 'vitest';
import type { Reranker } from '@app/domain';

/**
 * Shared contract assertions every Reranker implementation must satisfy.
 * Implementations may return documents in any order; the contract only pins
 * that every input document is ranked exactly once with its original index
 * and a 0..1 relevance score.
 */
export function runRerankerContract(makeReranker: () => Reranker): void {
  describe('reranker contract', () => {
    it('returns an empty list for empty documents', async () => {
      expect(await makeReranker().rank('query', [])).toEqual([]);
    });

    it('ranks every document exactly once with its original index', async () => {
      const reranker = makeReranker();
      const documents = ['alpha', 'beta', 'gamma'];
      const ranked = await reranker.rank('query', documents);
      expect(ranked).toHaveLength(documents.length);
      const indices = ranked.map((r) => r.index).sort((a, b) => a - b);
      expect(indices).toEqual([0, 1, 2]);
      for (const r of ranked) {
        expect(r.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(r.relevanceScore).toBeLessThanOrEqual(1);
      }
    });
  });
}
