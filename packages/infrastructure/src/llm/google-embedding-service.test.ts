import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createGoogleMock = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: (...args: unknown[]) => createGoogleMock(...args) }));

import { getEmbeddingModel, getGoogleEmbeddingModelId } from './google-embedding-service';

describe('google-embedding-service', () => {
  const original = { key: process.env.AI_STUDIO_KEY, model: process.env.GOOGLE_EMBEDDING_MODEL };

  beforeEach(() => {
    process.env.AI_STUDIO_KEY = 'test-key';
    delete process.env.GOOGLE_EMBEDDING_MODEL;
    createGoogleMock.mockReset();
    createGoogleMock.mockImplementation(() => ({
      textEmbedding: vi.fn((modelId: string) => ({ modelId })),
    }));
  });

  afterEach(() => {
    process.env.AI_STUDIO_KEY = original.key;
    if (original.model === undefined) delete process.env.GOOGLE_EMBEDDING_MODEL;
    else process.env.GOOGLE_EMBEDDING_MODEL = original.model;
  });

  it('defaults to gemini-embedding-001 when GOOGLE_EMBEDDING_MODEL is unset', () => {
    expect(getGoogleEmbeddingModelId()).toBe('gemini-embedding-001');
    expect(getEmbeddingModel()).toEqual({ modelId: 'gemini-embedding-001' });
  });

  it('honors GOOGLE_EMBEDDING_MODEL', () => {
    process.env.GOOGLE_EMBEDDING_MODEL = 'gemini-embedding-002';
    expect(getGoogleEmbeddingModelId()).toBe('gemini-embedding-002');
    expect(getEmbeddingModel()).toEqual({ modelId: 'gemini-embedding-002' });
  });

  it('throws without AI_STUDIO_KEY', () => {
    delete process.env.AI_STUDIO_KEY;
    expect(() => getEmbeddingModel()).toThrow('AI_STUDIO_KEY is not set');
  });
});
