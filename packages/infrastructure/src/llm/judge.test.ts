import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { generateTextMock, getChatModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getChatModelMock: vi.fn(() => ({ modelId: 'mock-grade' })),
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

vi.mock('./index', async () => {
  const actual = await vi.importActual<typeof import('./index')>('./index');
  return { ...actual, getChatModel: getChatModelMock };
});

vi.mock('./retry', async () => {
  const actual = await vi.importActual<typeof import('./retry')>('./retry');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

import { judgeRelevance, judgeFaithfulness } from './judge';
import type { ChatModelProvider } from './registries';
import { GRADE_MODEL } from '@app/infrastructure/config';

let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  generateTextMock.mockReset();
  getChatModelMock.mockReset();
  getChatModelMock.mockReturnValue({ modelId: 'mock-grade' });
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
});

const retryable = Object.assign(new Error('rate limited'), { statusCode: 429 });
const timedOut = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });

describe('judgeRelevance', () => {
  it('returns the parsed verdict on the happy path', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"score":0.9,"reason":"chunks answer the question"}',
    });
    expect(await judgeRelevance('refund policy?', ['chunk one', 'chunk two'])).toEqual({
      score: 0.9,
      reason: 'chunks answer the question',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.system).toContain('You are a relevance judge.');
    expect(call.prompt).toContain('QUESTION:refund policy?');
    expect(call.prompt).toContain('DOCS:chunk one\n\nchunk two');
    expect(call.maxOutputTokens).toBe(200);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('clamps out-of-range scores into [0,1]', async () => {
    generateTextMock.mockResolvedValue({ text: '{"score":1.7,"reason":"over"}' });
    expect((await judgeRelevance('q', ['d']))!.score).toBe(1);
    generateTextMock.mockResolvedValue({ text: '{"score":-2,"reason":"under"}' });
    expect((await judgeRelevance('q', ['d']))!.score).toBe(0);
  });

  it('uses GRADE_MODEL through getChatModel by default', async () => {
    generateTextMock.mockResolvedValue({ text: '{"score":1,"reason":"r"}' });
    await judgeRelevance('q', ['d']);
    expect(getChatModelMock).toHaveBeenCalledWith(GRADE_MODEL || undefined);
  });
});

describe('judgeFaithfulness', () => {
  it('returns the parsed verdict with citationPrecision on the happy path', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"score":0.8,"citationPrecision":0.75,"reason":"every sentence supported"}',
    });
    expect(await judgeFaithfulness('DOC A\nDOC B', 'Generated answer text')).toEqual({
      score: 0.8,
      citationPrecision: 0.75,
      reason: 'every sentence supported',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.prompt).toContain('DOCUMENTS:DOC A\nDOC B');
    expect(call.prompt).toContain('ANSWER:Generated answer text');
  });

  it('includes the disclaimer-ignore sentence in the system prompt', async () => {
    generateTextMock.mockResolvedValue({
      text: '{"score":0.8,"citationPrecision":0.7,"reason":"r"}',
    });
    await judgeFaithfulness('docs', 'answer');
    const system = String(generateTextMock.mock.calls[0]![0].system);
    expect(system).toContain(
      'Ignore leading disclaimer preambles like "Note: I couldn\'t find a strongly matching document, so this is my best guess..." when judging',
    );
  });

  it('treats a missing citationPrecision as malformed and gives up after one retry', async () => {
    generateTextMock.mockResolvedValue({ text: '{"score":0.9,"reason":"no precision field"}' });
    expect(await judgeFaithfulness('docs', 'answer')).toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('malformed output handling', () => {
  it('retries once then falls back to lenient substring parsing (relevance)', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'I cannot answer that.' });
    generateTextMock.mockResolvedValueOnce({
      text: 'Verdict: {"score":0.6,"reason":"partially relevant"} — end of review.',
    });
    expect(await judgeRelevance('q', ['d'])).toEqual({
      score: 0.6,
      reason: 'partially relevant',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('retries once then falls back to lenient substring parsing (faithfulness)', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'oops' });
    generateTextMock.mockResolvedValueOnce({
      text: 'Answer {"score":0.55,"citationPrecision":0.4,"reason":"meh"} done',
    });
    expect(await judgeFaithfulness('docs', 'answer')).toEqual({
      score: 0.55,
      citationPrecision: 0.4,
      reason: 'meh',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and logs the stable event when both attempts are unparseable', async () => {
    generateTextMock.mockResolvedValue({ text: 'garbage, no JSON here' });
    expect(await judgeFaithfulness('docs', 'answer')).toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('judge.faithfulness.failed'));
  });

  it('treats a non-numeric score as malformed', async () => {
    generateTextMock.mockResolvedValue({ text: '{"score":"high","reason":"x"}' });
    expect(await judgeRelevance('q', ['d'])).toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('failure containment', () => {
  it('returns null without throwing after transient errors exhaust the retries', async () => {
    generateTextMock.mockRejectedValue(retryable);
    await expect(judgeRelevance('q', ['d'])).resolves.toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('judge.relevance.failed'));
  });

  it('returns null without throwing on a timeout', async () => {
    generateTextMock.mockRejectedValue(timedOut);
    await expect(judgeFaithfulness('docs', 'answer')).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('judge.faithfulness.failed'));
  });

  it('returns null immediately on a permanent error', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    await expect(judgeRelevance('q', ['d'])).resolves.toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('dependency injection', () => {
  it('forwards gradeModelId to an injected provider instead of getChatModel', async () => {
    const modelProvider = vi.fn(
      () => ({ modelId: 'injected' }),
    ) as unknown as ChatModelProvider;
    generateTextMock.mockResolvedValue({ text: '{"score":1,"reason":"r"}' });
    await judgeRelevance('q', ['d'], { gradeModelId: 'custom-grade-model', modelProvider });
    expect(modelProvider).toHaveBeenCalledWith('custom-grade-model');
    expect(getChatModelMock).not.toHaveBeenCalled();
  });

  it('uses the injected provider default for faithfulness too', async () => {
    const modelProvider = vi.fn(
      () => ({ modelId: 'injected' }),
    ) as unknown as ChatModelProvider;
    generateTextMock.mockResolvedValue({
      text: '{"score":0.8,"citationPrecision":0.5,"reason":"r"}',
    });
    await judgeFaithfulness('docs', 'answer', { modelProvider });
    expect(modelProvider).toHaveBeenCalledTimes(1);
    expect(modelProvider).toHaveBeenCalledWith(GRADE_MODEL || undefined);
    expect(getChatModelMock).not.toHaveBeenCalled();
  });
});
