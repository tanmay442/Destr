import { describe, it, expect } from 'vitest';
import type { EmbeddingService } from '@app/domain';

export interface EmbeddingServiceContractOptions {
  /** The vector width every embedding must have. */
  dimension: number;
  /**
   * Deterministic per-input vector the impl's mocked provider returns.
   * Passed to both the impl test file's `ai` mock and the harness so order
   * preservation can be asserted against the same mapping.
   */
  vectorFor: (value: string, index: number) => number[];
}

/**
 * Shared contract assertions every EmbeddingService implementation must
 * satisfy. The provider is mocked in the impl test file; `vectorFor` pins
 * the exact expected vectors so count, order, and dimension are all asserted.
 */
export function runEmbeddingServiceContract(
  makeEmbedder: () => EmbeddingService,
  opts: EmbeddingServiceContractOptions,
): void {
  describe('embedding service contract', () => {
    it('embed returns a single vector of the configured dimension', async () => {
      const embedder = makeEmbedder();
      const vector = await embedder.embed('hello world');
      expect(vector).toEqual(opts.vectorFor('hello world', 0));
      expect(vector).toHaveLength(opts.dimension);
    });

    it('embedBatch returns one vector per input, preserving order', async () => {
      const embedder = makeEmbedder();
      const values = ['alpha', 'beta', 'gamma'];
      const result = await embedder.embedBatch(values);
      expect(result).toHaveLength(values.length);
      values.forEach((value, i) => {
        expect(result[i]).toEqual(opts.vectorFor(value, i));
        expect(result[i]).toHaveLength(opts.dimension);
      });
    });

    it('embedBatch handles an empty input', async () => {
      const embedder = makeEmbedder();
      expect(await embedder.embedBatch([])).toEqual([]);
    });
  });
}
