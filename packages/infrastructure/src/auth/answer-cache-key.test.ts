import { describe, it, expect } from 'vitest';
import { answerCacheKey } from './answer-cache-key';

describe('answerCacheKey', () => {
  const models = { embeddingModel: 'gemini-embedding-001', chatModel: 'gemini-2.0-flash' };

  it('normalises whitespace, case, and surrounding spaces to a stable key', () => {
    const a = answerCacheKey('  What is the  POLICY? ', models);
    const b = answerCacheKey('what is the policy ?', models);
    const c = answerCacheKey('WHAT   IS   THE   POLICY   ?', models);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.startsWith('rag:answer:')).toBe(true);
  });

  it('produces different keys for different questions', () => {
    const a = answerCacheKey('how do I reset my password', models);
    const b = answerCacheKey('what is the refund policy', models);
    expect(a).not.toBe(b);
  });

  it('pins the embedding + chat model ids into the key', () => {
    const a = answerCacheKey('same question', { embeddingModel: 'model-a', chatModel: 'chat-a' });
    const b = answerCacheKey('same question', { embeddingModel: 'model-b', chatModel: 'chat-a' });
    const c = answerCacheKey('same question', { embeddingModel: 'model-a', chatModel: 'chat-b' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('returns a 32-char hash suffix', () => {
    const key = answerCacheKey('anything', models);
    expect(key).toMatch(/^rag:answer:[a-f0-9]{32}$/);
  });
});
