import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

vi.mock('./index', () => ({ getChatModel: vi.fn().mockReturnValue({ id: 'fake-model' }) }));
vi.mock('./model', () => ({ getChatModel: vi.fn().mockReturnValue({ id: 'fake-model' }) }));

import { docSummarizer, createDocSummarizer, clearDocContextCache, getDocContextCacheSize } from './doc-summarizer';
import { CCH_CONTEXT_CHARS } from '@app/domain';

describe('docSummarizer (Contextual Chunk Headers)', () => {
  beforeEach(() => {
    generateText.mockReset();
    clearDocContextCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses JSON output and truncates the prompt to CCH_CONTEXT_CHARS', async () => {
    generateText.mockResolvedValue({ text: '{"title":"My Title","summary":"My summary."}' });
    const long = 'x'.repeat(CCH_CONTEXT_CHARS + 5000);

    const res = await docSummarizer.generateDocContext(long);

    expect(res).toEqual({ title: 'My Title', summary: 'My summary.' });
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0]![0];
    expect(call.model).toEqual({ id: 'fake-model' });
    expect(call.maxOutputTokens).toBeGreaterThan(0);
    expect(call.prompt.length).toBeLessThanOrEqual(CCH_CONTEXT_CHARS + 256);
  });

  it('strips ```json fences', async () => {
    generateText.mockResolvedValue({
      text: '```json\n{"title":"Fenced","summary":"S."}\n```',
    });
    const res = await docSummarizer.generateDocContext('doc');
    expect(res).toEqual({ title: 'Fenced', summary: 'S.' });
  });

  it('does not throw on malformed output and returns best-effort parse', async () => {
    generateText.mockResolvedValue({ text: 'Sure! The title is Hello and it is about world.' });
    const res = await docSummarizer.generateDocContext('hello world');
    expect(res).toHaveProperty('title');
    expect(res).toHaveProperty('summary');
    expect(res.title.length).toBeGreaterThan(0);
  });

  it('caches by input excerpt: same input skips the LLM, different input calls it', async () => {
    generateText.mockResolvedValue({ text: '{"title":"Cached","summary":"S."}' });

    const first = await docSummarizer.generateDocContext('same document');
    const second = await docSummarizer.generateDocContext('same document');

    expect(first).toEqual({ title: 'Cached', summary: 'S.' });
    expect(second).toEqual(first);
    expect(generateText).toHaveBeenCalledTimes(1);

    await docSummarizer.generateDocContext('different document');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent identical inputs into a single in-flight call', async () => {
    generateText.mockResolvedValue({ text: '{"title":"Once","summary":"S."}' });

    const [a, b] = await Promise.all([
      docSummarizer.generateDocContext('concurrent'),
      docSummarizer.generateDocContext('concurrent'),
    ]);

    expect(a).toEqual({ title: 'Once', summary: 'S.' });
    expect(b).toEqual(a);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('does not cache empty results from failed generations', async () => {
    generateText.mockRejectedValueOnce(new Error('transient'));
    generateText.mockResolvedValue({ text: '{"title":"Recovered","summary":"S."}' });

    const first = await docSummarizer.generateDocContext('flaky document');
    const second = await docSummarizer.generateDocContext('flaky document');

    expect(first).toEqual({ title: '', summary: '' });
    expect(second).toEqual({ title: 'Recovered', summary: 'S.' });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('caps overly long titles and summaries before returning them', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({ title: 'T'.repeat(1000), summary: 'S'.repeat(5000) }),
    });
    const res = await docSummarizer.generateDocContext('doc');
    expect(res.title.length).toBeLessThanOrEqual(200);
    expect(res.summary.length).toBeLessThanOrEqual(1000);
  });

  it('strips control characters from title and summary', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({ title: 'A\u0000B\u001fC\nD', summary: 'S\u0007um.\u0000' }),
    });
    const res = await docSummarizer.generateDocContext('doc');
    expect(res.title).toBe('A B C D');
    expect(res.summary).toBe('S um.');
    expect(res.title).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(res.summary).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('falls back to document text when the model returns empty title and summary', async () => {
    generateText.mockResolvedValue({ text: '{"title":"","summary":""}' });
    const res = await docSummarizer.generateDocContext('Intro line of doc\nbody text here');
    expect(res.title).toBe('Intro line of doc');
    expect(res.summary).toContain('Intro line of doc');
    expect(res.summary).toContain('body text here');
  });

  it('falls back per-field when only one of title or summary is missing', async () => {
    generateText.mockResolvedValue({ text: '{"title":"","summary":"Good summary."}' });
    const res = await docSummarizer.generateDocContext('First line\nrest');
    expect(res.title).toBe('First line');
    expect(res.summary).toBe('Good summary.');
  });

  it('keys the cache on the full text, not just the shared excerpt prefix', async () => {
    generateText.mockResolvedValue({ text: '{"title":"T","summary":"S."}' });
    const prefix = 'x'.repeat(CCH_CONTEXT_CHARS);

    await docSummarizer.generateDocContext(prefix + 'AAAA');
    await docSummarizer.generateDocContext(prefix + 'BBBB');

    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry once the LRU cap is reached', async () => {
    generateText.mockResolvedValue({ text: '{"title":"T","summary":"S."}' });

    for (let i = 0; i < 2001; i++) {
      await docSummarizer.generateDocContext(`document ${i}`);
    }

    expect(getDocContextCacheSize()).toBeLessThanOrEqual(2000);
  });

  it('expires stale entries after the TTL and regenerates', async () => {
    vi.useFakeTimers();
    generateText.mockResolvedValue({ text: '{"title":"Old","summary":"S."}' });
    await docSummarizer.generateDocContext('same text');

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    generateText.mockResolvedValue({ text: '{"title":"Fresh","summary":"S."}' });
    const res = await docSummarizer.generateDocContext('same text');

    expect(res.title).toBe('Fresh');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('uses an injected model provider instead of the default chat model', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as (modelId?: string) => import('@ai-sdk/provider').LanguageModelV3;
    const summarizer = createDocSummarizer(modelProvider);
    generateText.mockResolvedValue({ text: '{"title":"Injected","summary":"S."}' });

    const res = await summarizer.generateDocContext('injected document');

    expect(res).toEqual({ title: 'Injected', summary: 'S.' });
    expect(modelProvider).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]![0].model).toEqual({ modelId: 'injected' });
  });
});
