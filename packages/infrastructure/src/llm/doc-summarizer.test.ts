import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

vi.mock('./index', () => ({ getChatModel: vi.fn().mockReturnValue({ id: 'fake-model' }) }));

import { docSummarizer } from './doc-summarizer';
import { CCH_CONTEXT_CHARS } from '../../../../config/constants';

describe('docSummarizer (Contextual Chunk Headers)', () => {
  beforeEach(() => {
    generateText.mockReset();
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
    // The prompt wraps the (truncated) excerpt; it must not exceed the cap by much.
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
});
