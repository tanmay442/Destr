import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createGoogleMock = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: (...args: unknown[]) => createGoogleMock(...args) }));

import { getGoogleChatModel, getGoogleChatModelId } from './google-chat-service';

describe('google-chat-service', () => {
  const original = { key: process.env.AI_STUDIO_KEY, model: process.env.GOOGLE_CHAT_MODEL };

  beforeEach(() => {
    process.env.AI_STUDIO_KEY = 'test-key';
    delete process.env.GOOGLE_CHAT_MODEL;
    createGoogleMock.mockReset();
    createGoogleMock.mockImplementation(() => ({
      chat: vi.fn((modelId: string) => ({ modelId })),
    }));
  });

  afterEach(() => {
    process.env.AI_STUDIO_KEY = original.key;
    if (original.model === undefined) delete process.env.GOOGLE_CHAT_MODEL;
    else process.env.GOOGLE_CHAT_MODEL = original.model;
  });

  it('defaults to the current Gemini flash model when GOOGLE_CHAT_MODEL is unset', () => {
    expect(getGoogleChatModelId()).toBe('gemini-2.5-flash');
    const model = getGoogleChatModel();
    expect(model).toEqual({ modelId: 'gemini-2.5-flash' });
  });

  it('honors GOOGLE_CHAT_MODEL and an explicit model id override', () => {
    process.env.GOOGLE_CHAT_MODEL = 'gemini-2.5-pro';
    expect(getGoogleChatModelId()).toBe('gemini-2.5-pro');
    expect(getGoogleChatModel()).toEqual({ modelId: 'gemini-2.5-pro' });
    expect(getGoogleChatModel('gemini-2.5-flash-lite')).toEqual({ modelId: 'gemini-2.5-flash-lite' });
  });

  it('throws without AI_STUDIO_KEY', () => {
    delete process.env.AI_STUDIO_KEY;
    expect(() => getGoogleChatModel()).toThrow('AI_STUDIO_KEY is not set');
  });
});
