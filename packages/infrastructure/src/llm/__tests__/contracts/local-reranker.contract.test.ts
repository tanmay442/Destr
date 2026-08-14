import { describe, vi, beforeEach } from 'vitest';
import { localReranker } from '../../local-reranker';
import { runRerankerContract } from './reranker-contract';

const tokenizerImpl = vi.hoisted(() => vi.fn());
const modelImpl = vi.hoisted(() => vi.fn());

vi.mock('@xenova/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: vi.fn().mockResolvedValue(tokenizerImpl) },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockResolvedValue(modelImpl) },
}));

describe('local reranker contract', () => {
  beforeEach(() => {
    tokenizerImpl.mockReset();
    modelImpl.mockReset();
    tokenizerImpl.mockResolvedValue({ inputIds: [1, 2, 3] });
    modelImpl.mockResolvedValue({ logits: { data: [2.0, 0.0, -2.0] } });
  });

  runRerankerContract(() => localReranker);
});
