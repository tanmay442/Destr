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

import { queryRewriter, documentGrader, hallucinationGrader, getGraderFailureCounts, createGraders } from './graders';
import { getGraders } from './index';

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  generateTextMock.mockReset();
  getChatModelMock.mockReset();
  getChatModelMock.mockReturnValue({ modelId: 'mock-grade' });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const retryable = Object.assign(new Error('rate limited'), { statusCode: 429 });

describe('queryRewriter', () => {
  it('returns the rewritten query from the model', async () => {
    generateTextMock.mockResolvedValue({ text: '  school cell phone policy  ' });
    expect(await queryRewriter.rewrite('phones at school')).toBe('school cell phone policy');
  });

  it('echoes the original query when the model returns empty', async () => {
    generateTextMock.mockResolvedValue({ text: '   ' });
    expect(await queryRewriter.rewrite('original')).toBe('original');
  });

  it('echoes the original query when the model call throws (fail-open is safe here)', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    expect(await queryRewriter.rewrite('original')).toBe('original');
    expect(getGraderFailureCounts().queryRewriter).toBeGreaterThan(0);
  });
});

describe('documentGrader', () => {
  it('returns yes when the model grades relevant', async () => {
    generateTextMock.mockResolvedValue({ text: 'yes' });
    expect(await documentGrader.grade('q', 'doc')).toBe('yes');
  });

  it('returns no when the model grades irrelevant', async () => {
    generateTextMock.mockResolvedValue({ text: 'no' });
    expect(await documentGrader.grade('q', 'doc')).toBe('no');
  });

  it('passes the question and full document into the grading prompt', async () => {
    generateTextMock.mockResolvedValue({ text: 'yes' });
    await documentGrader.grade('what is refund policy', 'Refund policy: 30 days');
    const prompt = String(generateTextMock.mock.calls[0]![0].prompt);
    expect(prompt).toContain('QUESTION:\nwhat is refund policy');
    expect(prompt).toContain('BEGIN DOCUMENT\nRefund policy: 30 days');
    expect(prompt).toContain('END DOCUMENT');
  });

  it('fails closed (returns no) when the model call throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    expect(await documentGrader.grade('q', 'doc')).toBe('no');
    expect(getGraderFailureCounts().documentGrader).toBeGreaterThan(0);
  });

  it('retries transient failures before failing closed', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce({ text: 'yes' });
    expect(await documentGrader.grade('q', 'doc')).toBe('yes');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('hallucinationGrader', () => {
  it('returns yes when the answer is grounded', async () => {
    generateTextMock.mockResolvedValue({ text: 'yes' });
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
  });

  it('returns no when the answer is not grounded', async () => {
    generateTextMock.mockResolvedValue({ text: 'no' });
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('no');
  });

  it('passes documents and generation into the grading prompt', async () => {
    generateTextMock.mockResolvedValue({ text: 'yes' });
    await hallucinationGrader.grade('DOC A', 'Generated answer text');
    const prompt = String(generateTextMock.mock.calls[0]![0].prompt);
    expect(prompt).toContain('BEGIN DOCUMENTS\nDOC A');
    expect(prompt).toContain('GENERATED ANSWER:\nGenerated answer text');
    expect(prompt).toContain('END DOCUMENTS');
  });

  it('fails closed (treats answer as ungrounded) when the model call throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('no');
    expect(getGraderFailureCounts().hallucinationGrader).toBeGreaterThan(0);
  });

  it('never flips to grounded on a persistent retryable outage', async () => {
    generateTextMock.mockRejectedValue(retryable);
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('no');
    expect(generateTextMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('retries transient failures before returning a verdict', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce({ text: 'yes' });
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('gradeVerdict fail-closed parsing', () => {
  it.each([
    ['yes', 'yes'],
    ['Yes', 'yes'],
    ['YES', 'yes'],
    ['  yes  ', 'yes'],
    ['yes.', 'yes'],
    ['Yes!', 'yes'],
    ['no', 'no'],
    ['No.', 'no'],
    ['NO', 'no'],
  ])('maps explicit verdict %j to %j', async (text, expected) => {
    generateTextMock.mockResolvedValue({ text });
    expect(await documentGrader.grade('q', 'doc')).toBe(expected);
  });

  it.each([
    ['uncertain', 'no'],
    ['cannot determine', 'no'],
    ['maybe', 'no'],
    ['not sure', 'no'],
    ['garbage text here', 'no'],
    ['', 'no'],
    ['yess', 'no'],
    ['yes no', 'no'],
    ['123', 'no'],
    ['n o', 'no'],
  ])('fails closed for ambiguous output %j -> %j', async (text, expected) => {
    generateTextMock.mockResolvedValue({ text });
    expect(await documentGrader.grade('q', 'doc')).toBe(expected);
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe(expected);
  });
});

describe('getGraders selector', () => {
  it('returns undefined graders when AGENTIC_ENABLED=false', async () => {
    const prev = process.env.AGENTIC_ENABLED;
    process.env.AGENTIC_ENABLED = 'false';
    const g = getGraders();
    expect(g.queryRewriter).toBeUndefined();
    expect(g.documentGrader).toBeUndefined();
    expect(g.hallucinationGrader).toBeUndefined();
    process.env.AGENTIC_ENABLED = prev ?? '';
  });

  it('returns the adapters when enabled', async () => {
    const prev = process.env.AGENTIC_ENABLED;
    delete process.env.AGENTIC_ENABLED;
    const g = getGraders();
    expect(g.queryRewriter).toBeDefined();
    expect(g.documentGrader).toBeDefined();
    expect(g.hallucinationGrader).toBeDefined();
    process.env.AGENTIC_ENABLED = prev ?? '';
  });
});

describe('createGraders with an injected model provider', () => {
  it('uses the injected provider instead of the default chat model', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as (modelId?: string) => import('@ai-sdk/provider').LanguageModelV3;
    const graders = createGraders(undefined, modelProvider);
    generateTextMock.mockResolvedValue({ text: 'yes' });
    await graders.documentGrader.grade('q', 'doc');
    expect(modelProvider).toHaveBeenCalledTimes(1);
    expect(getChatModelMock).not.toHaveBeenCalled();
  });

  it('passes the grade model override to the injected provider', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as (modelId?: string) => import('@ai-sdk/provider').LanguageModelV3;
    const graders = createGraders('custom-grade-model', modelProvider);
    generateTextMock.mockResolvedValue({ text: 'no' });
    await graders.hallucinationGrader.grade('docs', 'answer');
    expect(modelProvider).toHaveBeenCalledWith('custom-grade-model');
  });
});
