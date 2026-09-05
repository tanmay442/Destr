import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createOpenAIMock = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (...args: unknown[]) => createOpenAIMock(...args) }));

import { getOpenAIChatModel } from './openai-chat-service';
import { getOpenAIOperationPath, normalizeOpenAIBaseURL } from './openai-base-url';

describe('openai-chat-service', () => {
  const original = { key: process.env.CUSTOM_LLM_API_KEY, base: process.env.CUSTOM_LLM_BASE_URL, model: process.env.LLM_MODEL };

  beforeEach(() => {
    process.env.CUSTOM_LLM_API_KEY = 'test-key';
    process.env.CUSTOM_LLM_BASE_URL = 'http://localhost:1234/v1';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    createOpenAIMock.mockReset();
    createOpenAIMock.mockImplementation(() => ({
      chat: vi.fn((modelId: string) => ({ modelId, operation: 'chat' })),
      responses: vi.fn((modelId: string) => ({ modelId, operation: 'responses' })),
    }));
  });

  afterEach(() => {
    process.env.CUSTOM_LLM_API_KEY = original.key;
    process.env.CUSTOM_LLM_BASE_URL = original.base;
    process.env.LLM_MODEL = original.model;
  });

  it('fails fast when LLM_MODEL is unset and no explicit model id is given', () => {
    delete process.env.LLM_MODEL;
    expect(() => getOpenAIChatModel()).toThrow('LLM_MODEL must be set');
    expect(createOpenAIMock).not.toHaveBeenCalled();
  });

  it('uses LLM_MODEL as the default model', () => {
    const model = getOpenAIChatModel();
    expect(model).toEqual({ modelId: 'gpt-4o-mini', operation: 'chat' });
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
  });

  it('selects the Responses API for a configured /responses endpoint', () => {
    process.env.CUSTOM_LLM_BASE_URL = 'https://opencode.ai/zen/v1/responses';
    const model = getOpenAIChatModel();
    expect(model).toEqual({ modelId: 'gpt-4o-mini', operation: 'responses' });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://opencode.ai/zen/v1',
    });
  });

  it('selects Chat Completions for a configured /chat/completions endpoint', () => {
    process.env.CUSTOM_LLM_BASE_URL = 'https://proxy.example.com/v1/chat/completions';
    const model = getOpenAIChatModel();
    expect(model).toEqual({ modelId: 'gpt-4o-mini', operation: 'chat' });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com/v1',
    });
  });

  it('selects Chat Completions for a root-compatible endpoint', () => {
    process.env.CUSTOM_LLM_BASE_URL = 'https://proxy.example.com';
    const model = getOpenAIChatModel();
    expect(model).toEqual({ modelId: 'gpt-4o-mini', operation: 'chat' });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com/v1',
    });
  });

  it('an explicit model id wins over LLM_MODEL', () => {
    const model = getOpenAIChatModel('custom-model');
    expect(model).toEqual({ modelId: 'custom-model', operation: 'chat' });
  });

  it('throws when credentials are missing', () => {
    delete process.env.CUSTOM_LLM_API_KEY;
    expect(() => getOpenAIChatModel()).toThrow('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL');
    expect(createOpenAIMock).not.toHaveBeenCalled();

    process.env.CUSTOM_LLM_API_KEY = 'test-key';
    delete process.env.CUSTOM_LLM_BASE_URL;
    expect(() => getOpenAIChatModel()).toThrow('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL');
    expect(createOpenAIMock).not.toHaveBeenCalled();
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

  it('recognizes the Responses operation without exposing query or fragment values', () => {
    expect(getOpenAIOperationPath('https://opencode.ai/zen/v1/responses/?token=secret')).toBe('/responses');
    expect(getOpenAIOperationPath('https://opencode.ai/zen/v1?next=/responses#secret')).toBe('/chat/completions');
  });

  it('defaults unknown and root paths to Chat Completions', () => {
    expect(getOpenAIOperationPath('https://proxy.example.com/v1')).toBe('/chat/completions');
    expect(getOpenAIOperationPath('https://proxy.example.com/v1/embeddings')).toBe('/chat/completions');
  });
});
