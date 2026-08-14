import { describe, vi, beforeEach, afterEach } from 'vitest';
import { cohereReranker } from '../../cohere-reranker';
import { runRerankerContract } from './reranker-contract';

const fetchMock = vi.hoisted(() => vi.fn());

describe('cohere reranker contract', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.7 },
          { index: 2, relevance_score: 0.5 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('COHERE_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  runRerankerContract(() => cohereReranker);
});
