import { describe, it, expect, vi, beforeEach } from 'vitest';

const embedBatchWithModelMock = vi.hoisted(() => vi.fn());

vi.mock('../db/schema-vector', () => ({ resolveVectorDim: () => 2 }));
vi.mock('./embedding-batch-helper', () => ({ embedBatchWithModel: embedBatchWithModelMock }));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ textEmbedding: vi.fn(() => ({ modelId: 'ollama-embed' })) })),
}));

import { createOllamaEmbeddingService } from './ollama-embedding-service';
import { defaultProcessEnv } from '../config/env';

const buildService = () => createOllamaEmbeddingService({ env: defaultProcessEnv, vectorDim: 2 });

describe('ollamaEmbeddingService', () => {
  beforeEach(() => {
    embedBatchWithModelMock.mockReset();
  });

  it('returns the embedding when the dimension matches VECTOR_DIM', async () => {
    embedBatchWithModelMock.mockResolvedValue([[0.1, 0.2]]);
    const embedding = await buildService().embed('hello');
    expect(embedding).toEqual([0.1, 0.2]);
  });

  it('throws a clear config error when the model emits the wrong dimension', async () => {
    embedBatchWithModelMock.mockResolvedValue([[0.1, 0.2, 0.3]]);
    await expect(buildService().embed('hello')).rejects.toThrow(
      'returned 3-dimension vectors, but EMBEDDING_DIMENSION=2',
    );
  });

  it('validates every vector in a batch', async () => {
    embedBatchWithModelMock.mockResolvedValue([[0.1, 0.2], [0.3]]);
    await expect(buildService().embedBatch(['a', 'b'])).rejects.toThrow(
      'returned 1-dimension vectors, but EMBEDDING_DIMENSION=2',
    );
  });

  it('returns all vectors when the batch matches the expected dimension', async () => {
    embedBatchWithModelMock.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);
    const result = await buildService().embedBatch(['a', 'b']);
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });
});
