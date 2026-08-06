import { describe, it, expect, vi, beforeEach } from 'vitest';
import { localReranker } from './local-reranker';

const tokenizerImpl = vi.hoisted(() => vi.fn());
const modelImpl = vi.hoisted(() => vi.fn());

vi.mock('@xenova/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: vi.fn().mockResolvedValue(tokenizerImpl) },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockResolvedValue(modelImpl) },
}));

describe('localReranker', () => {
  beforeEach(() => {
    tokenizerImpl.mockReset();
    modelImpl.mockReset();
  });

  it('returns empty for empty input without loading the encoder', async () => {
    const result = await localReranker.rank('q', []);
    expect(result).toEqual([]);
  });

  it('normalizes logits through sigmoid into 0..1 scores in document order', async () => {
    tokenizerImpl.mockResolvedValue({ inputIds: [1, 2, 3] });
    modelImpl.mockResolvedValue({ logits: { data: [2.0, 0.0, -2.0] } });

    const ranked = await localReranker.rank('query', ['a', 'b', 'c']);

    expect(ranked).toHaveLength(3);
    for (const r of ranked) {
      expect(r.relevanceScore).toBeGreaterThan(0);
      expect(r.relevanceScore).toBeLessThan(1);
    }
    expect(ranked[0]!.relevanceScore).toBeGreaterThan(ranked[1]!.relevanceScore);
    expect(ranked[1]!.relevanceScore).toBeGreaterThan(ranked[2]!.relevanceScore);
    expect(ranked[1]!.relevanceScore).toBeCloseTo(0.5, 5);
  });

  it('sorts by relevance score when the caller reorders', async () => {
    tokenizerImpl.mockResolvedValue({});
    modelImpl.mockResolvedValue({ logits: { data: [-1.0, 3.0] } });

    const ranked = await localReranker.rank('query', ['low', 'high']);
    const ordered = [...ranked].sort((a, b) => b.relevanceScore - a.relevanceScore);

    expect(ordered[0]!.index).toBe(1);
    expect(ordered[1]!.index).toBe(0);
  });
});
