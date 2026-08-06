import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Llm from './index';
import { googleEmbeddingService } from './google-embedding-service-port';
import { openAIEmbeddingService } from './openai-embedding-service';
import { ollamaEmbeddingService } from './ollama-embedding-service';

describe('LLM provider factory dispatch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the Google embedding adapter by default', () => {
    delete process.env.EMBEDDING_PROVIDER;
    expect(Llm.getEmbeddingService()).toBe(googleEmbeddingService);
  });

  it('returns the Google embedding adapter when EMBEDDING_PROVIDER=google', () => {
    process.env.EMBEDDING_PROVIDER = 'google';
    expect(Llm.getEmbeddingService()).toBe(googleEmbeddingService);
  });

  it('returns the OpenAI embedding adapter when EMBEDDING_PROVIDER=openai', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(Llm.getEmbeddingService()).toBe(openAIEmbeddingService);
  });

  it('returns the Ollama embedding adapter when EMBEDDING_PROVIDER=ollama', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    expect(Llm.getEmbeddingService()).toBe(ollamaEmbeddingService);
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
});
