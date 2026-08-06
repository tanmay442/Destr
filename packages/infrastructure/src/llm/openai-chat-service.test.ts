import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createOpenAIMock = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (...args: unknown[]) => createOpenAIMock(...args) }));

import { getChatModel } from './openai-chat-service';
import { normalizeOpenAIBaseURL } from './openai-base-url';

describe('openai-chat-service', () => {
  const original = { key: process.env.CUSTOM_LLM_API_KEY, base: process.env.CUSTOM_LLM_BASE_URL, model: process.env.LLM_MODEL };

  beforeEach(() => {
    process.env.CUSTOM_LLM_API_KEY = 'test-key';
    process.env.CUSTOM_LLM_BASE_URL = 'http://localhost:1234/v1';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    createOpenAIMock.mockReset();
    createOpenAIMock.mockImplementation(() => ({
      chat: vi.fn((modelId: string) => ({ modelId })),
    }));
  });

  afterEach(() => {
    process.env.CUSTOM_LLM_API_KEY = original.key;
    process.env.CUSTOM_LLM_BASE_URL = original.base;
    process.env.LLM_MODEL = original.model;
  });

  it('fails fast when LLM_MODEL is unset and no explicit model id is given', () => {
    delete process.env.LLM_MODEL;
    expect(() => getChatModel()).toThrow('LLM_MODEL must be set');
    expect(createOpenAIMock).not.toHaveBeenCalled();
  });

  it('uses LLM_MODEL as the default model', () => {
    const model = getChatModel();
    expect(model).toEqual({ modelId: 'gpt-4o-mini' });
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
  });

  it('an explicit model id wins over LLM_MODEL', () => {
    const model = getChatModel('custom-model');
    expect(model).toEqual({ modelId: 'custom-model' });
  });

  it('throws when credentials are missing', () => {
    delete process.env.CUSTOM_LLM_API_KEY;
    delete process.env.CUSTOM_LLM_BASE_URL;
    expect(() => getChatModel()).toThrow('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL');
  });
});

describe('normalizeOpenAIBaseURL', () => {
  it('appends /v1 for hosts without it', () => {
    expect(normalizeOpenAIBaseURL('http://host:1234')).toBe('http://host:1234/v1');
    expect(normalizeOpenAIBaseURL('https://proxy.example.com')).toBe('https://proxy.example.com/v1');
  });

  it('strips trailing slashes', () => {
    expect(normalizeOpenAIBaseURL('http://host:1234/v1/')).toBe('http://host:1234/v1');
  });

  it('strips any path beyond /v1', () => {
    expect(normalizeOpenAIBaseURL('http://host:1234/v1/responses')).toBe('http://host:1234/v1');
    expect(normalizeOpenAIBaseURL('https://proxy.example.com/v1/embeddings')).toBe(
      'https://proxy.example.com/v1',
    );
  });

  it('keeps an already-clean /v1 base URL unchanged', () => {
    expect(normalizeOpenAIBaseURL('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1');
  });
});
