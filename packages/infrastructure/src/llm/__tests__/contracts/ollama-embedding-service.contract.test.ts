import { describe, vi, beforeEach } from 'vitest';

const embedManyMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, embedMany: embedManyMock };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ textEmbedding: vi.fn(() => ({ modelId: 'test-embed' })) })),
}));

vi.mock('../../../db/schema-vector', () => ({ VECTOR_DIM: 3 }));

import { ollamaEmbeddingService } from '../../ollama-embedding-service';
import { runEmbeddingServiceContract } from './embedding-service-contract';

const DIMENSION = 3;
const vectorFor = (value: string, index: number) => [index, value.length % 10, 0];

describe('ollama embedding service contract', () => {
  beforeEach(() => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((value, i) => vectorFor(value, i)),
    }));
  });

  runEmbeddingServiceContract(() => ollamaEmbeddingService, { dimension: DIMENSION, vectorFor });
});
