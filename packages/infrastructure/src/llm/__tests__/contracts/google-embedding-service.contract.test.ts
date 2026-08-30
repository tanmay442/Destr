import { describe, vi, beforeEach, afterEach } from 'vitest';

const embedMock = vi.hoisted(() => vi.fn());
const embedManyMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, embed: embedMock, embedMany: embedManyMock };
});

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => ({ textEmbedding: vi.fn(() => ({ modelId: 'test-embed' })) })),
}));

import { googleEmbeddingService } from '../../google-embedding-service-port';
import { runEmbeddingServiceContract } from './embedding-service-contract';

const DIMENSION = 3;
const vectorFor = (value: string, index: number) => [index, value.length % 10, 0];

describe('google embedding service contract', () => {
  beforeEach(() => {
    vi.stubEnv('AI_STUDIO_KEY', 'test-key');
    vi.stubEnv('EMBEDDING_DIMENSION', String(DIMENSION));
    embedMock.mockImplementation(async ({ value }: { value: string }) => ({
      embedding: vectorFor(value, 0),
    }));
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((value, i) => vectorFor(value, i)),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  runEmbeddingServiceContract(() => googleEmbeddingService, { dimension: DIMENSION, vectorFor });
});
