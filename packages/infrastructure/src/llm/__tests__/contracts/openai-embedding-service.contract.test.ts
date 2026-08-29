import { describe, vi, beforeEach, afterEach } from 'vitest';

const embedMock = vi.hoisted(() => vi.fn());
const embedManyMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, embed: embedMock, embedMany: embedManyMock };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ textEmbedding: vi.fn(() => ({ modelId: 'test-embed' })) })),
}));

import { openAIEmbeddingService } from '../../openai-embedding-service';
import { runEmbeddingServiceContract } from './embedding-service-contract';

const DIMENSION = 3;
const vectorFor = (value: string, index: number) => [index, value.length % 10, 0];

describe('openai embedding service contract', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_EMBEDDING_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_EMBEDDING_BASE_URL', 'https://api.example.com');
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

  runEmbeddingServiceContract(() => openAIEmbeddingService, { dimension: DIMENSION, vectorFor });
});
