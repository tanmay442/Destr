import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EnvSource } from '@app/domain';
import * as Llm from './index';

function fakeEnv(values: Record<string, string> = {}): EnvSource {
  return { get: (key) => values[key] };
}

describe('LLM provider factory dispatch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns a fresh Google embedding service by default', () => {
    delete process.env.EMBEDDING_PROVIDER;
    const first = Llm.getEmbeddingService();
    const second = Llm.getEmbeddingService();
    expect(first).not.toBe(second);
    expect(typeof first.embedBatch).toBe('function');
  });

  it('honors an explicitly injected env set after import', () => {
    const env = fakeEnv({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_EMBEDDING_MODEL: 'injected-model' });
    expect(Llm.getEmbeddingModelId(env)).toBe('injected-model');
    const service = Llm.getEmbeddingService(768, env);
    expect(typeof service.embedBatch).toBe('function');
  });

  it('returns the OpenAI embedding adapter when EMBEDDING_PROVIDER=openai', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(typeof Llm.getEmbeddingService().embedBatch).toBe('function');
    expect(Llm.getEmbeddingModelId()).toBe(process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small');
  });

  it('returns the Ollama embedding adapter when EMBEDDING_PROVIDER=ollama', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    expect(typeof Llm.getEmbeddingService().embedBatch).toBe('function');
  });

  it('throws on an unknown embedding provider', () => {
    process.env.EMBEDDING_PROVIDER = 'unknown';
    expect(() => Llm.getEmbeddingService()).toThrow('Unknown EMBEDDING_PROVIDER: unknown');
  });

  it('returns a chat model for each provider without crashing', () => {
    process.env.CUSTOM_LLM_API_KEY = 'test-key';
    process.env.CUSTOM_LLM_BASE_URL = 'http://localhost:1234/v1';
    process.env.LLM_MODEL = 'test-model';
    delete process.env.CHAT_PROVIDER;
    expect(() => Llm.getChatModel()).not.toThrow();

    process.env.CHAT_PROVIDER = 'google';
    process.env.AI_STUDIO_KEY = 'test-key';
    expect(() => Llm.getChatModel()).not.toThrow();

    process.env.CHAT_PROVIDER = 'ollama';
    expect(() => Llm.getChatModel()).not.toThrow();
  });

  it('resolves the chat provider from an injected env', () => {
    const env = fakeEnv({ CHAT_PROVIDER: 'ollama', OLLAMA_CHAT_MODEL: 'injected-chat' });
    expect(Llm.getChatModel(undefined, env)).toMatchObject({ modelId: 'injected-chat' });
  });

  it('throws on an unknown chat provider', () => {
    process.env.CHAT_PROVIDER = 'unknown';
    expect(() => Llm.getChatModel()).toThrow('Unknown CHAT_PROVIDER: unknown');
  });
});

describe('getEmbeddingModelId', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves the google model from GOOGLE_EMBEDDING_MODEL when set', () => {
    delete process.env.EMBEDDING_PROVIDER;
    process.env.GOOGLE_EMBEDDING_MODEL = 'gemini-embedding-002';
    expect(Llm.getEmbeddingModelId()).toBe('gemini-embedding-002');
  });

  it('falls back to the google default model', () => {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.GOOGLE_EMBEDDING_MODEL;
    expect(Llm.getEmbeddingModelId()).toBe('gemini-embedding-001');
  });

  it('resolves the openai and ollama models from their env overrides', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large';
    expect(Llm.getEmbeddingModelId()).toBe('text-embedding-3-large');

    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
    expect(Llm.getEmbeddingModelId()).toBe('nomic-embed-text');
  });

  it('agrees with the registered service for every provider', () => {
    for (const provider of ['google', 'openai', 'ollama'] as const) {
      const env = fakeEnv({ EMBEDDING_PROVIDER: provider });
      expect(Llm.getEmbeddingModelId(env)).toBeTruthy();
      expect(typeof Llm.getEmbeddingService(768, env).embedBatch).toBe('function');
    }
  });
});

describe('reranker selection', () => {
  it('is a pure function of provider, env, and platform', () => {
    const withKey = fakeEnv({ COHERE_API_KEY: 'test-key' });
    const withoutKey = fakeEnv({});
    expect(Llm.resolveReranker('cohere', withKey, { isServerless: false })).toBeDefined();
    expect(Llm.resolveReranker('cohere', withoutKey, { isServerless: false })).toBeUndefined();
    expect(Llm.availableRerankers(withoutKey, { isServerless: false }).get('cohere')).toMatchObject({ ok: false });

    const serverless = fakeEnv({ RERANKER_PROVIDER: 'local', VERCEL: '1' });
    const local = fakeEnv({ RERANKER_PROVIDER: 'local' });
    expect(Llm.resolveReranker('local', serverless)).toBeUndefined();
    expect(Llm.availableRerankers(serverless).get('local')).toMatchObject({ ok: false });
    expect(Llm.resolveReranker('local', local)).toBeDefined();

    expect(Llm.resolveReranker('cosine', fakeEnv({}))).toBeUndefined();
    expect(Llm.getReranker('bogus', fakeEnv({}))).toBeUndefined();
  });

  it('derives the serverless platform flag from VERCEL', () => {
    expect(Llm.resolveRerankerPlatform(fakeEnv({ VERCEL: '1' }))).toMatchObject({ isServerless: true });
    expect(Llm.resolveRerankerPlatform(fakeEnv({}))).toMatchObject({ isServerless: false });
  });
});
