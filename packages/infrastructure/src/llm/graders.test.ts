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

import {
  queryRewriter,
  documentGrader,
  hallucinationGrader,
  getGraderFailureCounts,
  createGraders,
} from './graders';
import { getGraders } from './index';
import { GRADE_DOC_CHAR_CAP, GRADE_BATCH_DOCS } from '@app/domain';

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let consoleDebug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  generateTextMock.mockReset();
  getChatModelMock.mockReset();
  getChatModelMock.mockReturnValue({ modelId: 'mock-grade' });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  consoleDebug.mockRestore();
  vi.useRealTimers();
});

const retryable = Object.assign(new Error('rate limited'), { statusCode: 429 });

/** generateText result carrying a usable rate_chunks tool call. */
const rateChunksResult = (verdicts: unknown[]) => ({
  text: '',
  toolCalls: [
    {
      type: 'tool-call',
      toolCallId: 'call_rate',
      toolName: 'rate_chunks',
      input: { verdicts },
    },
  ],
});

/** generateText result carrying a usable grounded_verdict tool call. */
const groundedResult = (grounded: boolean) => ({
  text: '',
  toolCalls: [
    {
      type: 'tool-call',
      toolCallId: 'call_grounded',
      toolName: 'grounded_verdict',
      input: { grounded },
    },
  ],
});

const malformedResult = () => ({ text: '', toolCalls: [] });

const warnOutput = () => consoleWarn.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');

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

  it('echoes the original query without an LLM call when the shared turn budget is exhausted', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const graders = createGraders();
    generateTextMock.mockResolvedValue({ text: 'rewritten' });
    expect(await graders.queryRewriter.rewrite('first')).toBe('rewritten');

    vi.setSystemTime(start.getTime() + 26_000);
    const callsBefore = generateTextMock.mock.calls.length;
    expect(await graders.queryRewriter.rewrite('original')).toBe('original');
    expect(generateTextMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('documentGrader', () => {
  it('returns a full-length verdict array from one forced rate_chunks call', async () => {
    generateTextMock.mockResolvedValue(
      rateChunksResult([
        { index: 0, relevant: true },
        { index: 1, relevant: false },
        { index: 2, relevant: true },
        { index: 3, relevant: true },
      ]),
    );
    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['a', 'b', 'c', 'd'])).toEqual([
      'yes',
      'no',
      'yes',
      'yes',
    ]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('forces the rate_chunks tool and passes the abort signal and numbered documents', async () => {
    generateTextMock.mockResolvedValue(rateChunksResult([{ index: 0, relevant: true }]));
    const graders = createGraders();
    await graders.documentGrader.gradeAll('what is refund policy', ['Refund policy: 30 days']);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.tools?.rate_chunks).toBeDefined();
    expect(call.toolChoice).toBe('required');
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(String(call.prompt)).toContain('QUESTION:\nwhat is refund policy');
    expect(String(call.prompt)).toContain('DOCUMENTS:\n0. Refund policy: 30 days');
    expect(String(call.prompt)).toContain('rate_chunks');
  });

  it('retries transient failures before returning verdicts', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce(rateChunksResult([{ index: 0, relevant: true }]));
    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['doc'])).toEqual(['yes']);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and bumps the counter when retries are exhausted (timeout/outage)', async () => {
    generateTextMock.mockRejectedValue(retryable);
    const before = getGraderFailureCounts().documentGrader;
    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['doc'])).toBeNull();
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(getGraderFailureCounts().documentGrader).toBe(before + 1);
  });

  it('fills partial tool args: missing/wrong-type default to no, duplicates last-wins, out-of-range ignored', async () => {
    generateTextMock.mockResolvedValue(
      rateChunksResult([
        { index: 0, relevant: true },
        { index: 1, relevant: true },
        { index: 1, relevant: false }, // duplicate: last wins
        { index: '2', relevant: true }, // wrong index type -> default 'no'
        { index: 9, relevant: true }, // out-of-range -> ignored
        { index: 2 }, // missing relevant -> default 'no'
        { index: 3, relevant: 'yes' }, // wrong relevant type -> default 'no'
      ]),
    );
    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['a', 'b', 'c', 'd'])).toEqual([
      'yes',
      'no',
      'no',
      'no',
    ]);
  });

  it('trims oversized docs to GRADE_DOC_CHAR_CAP', async () => {
    const oversized =
      'HEAD' + 'x'.repeat(GRADE_DOC_CHAR_CAP - 4) + 'TAIL_MARKER_BEYOND_CAP';
    generateTextMock.mockResolvedValue(
      rateChunksResult([
        { index: 0, relevant: true },
        { index: 1, relevant: true },
      ]),
    );
    const graders = createGraders();
    await graders.documentGrader.gradeAll('q', [oversized, 'small doc']);

    const prompt = String(generateTextMock.mock.calls[0]![0].prompt);
    expect(prompt).toContain('HEAD');
    expect(prompt).not.toContain('TAIL_MARKER_BEYOND_CAP');
  });

  it('splits oversized sets into sub-batches of GRADE_BATCH_DOCS and merges by index', async () => {
    const bigDoc = (marker: number) => `${marker}${'x'.repeat(GRADE_DOC_CHAR_CAP - 1)}`;
    // 9 docs x 3000 chars = 27000 > GRADE_PROMPT_CHAR_BUDGET -> ceil(9/3) = 3 calls.
    const docs = Array.from({ length: 3 * GRADE_BATCH_DOCS }, (_, i) => bigDoc(i));
    generateTextMock
      .mockResolvedValueOnce(
        rateChunksResult([
          { index: 0, relevant: true },
          { index: 1, relevant: false },
          { index: 2, relevant: true },
        ]),
      )
      .mockResolvedValueOnce(
        rateChunksResult([
          { index: 3, relevant: false },
          { index: 4, relevant: false },
          { index: 5, relevant: false },
        ]),
      )
      .mockResolvedValueOnce(
        rateChunksResult([
          { index: 6, relevant: true },
          { index: 7, relevant: false },
          { index: 8, relevant: true },
        ]),
      );

    const graders = createGraders();
    const verdicts = await graders.documentGrader.gradeAll('q', docs);

    expect(verdicts).toEqual([
      'yes',
      'no',
      'yes',
      'no',
      'no',
      'no',
      'yes',
      'no',
      'yes',
    ]);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    const secondPrompt = String(generateTextMock.mock.calls[1]![0].prompt);
    expect(secondPrompt).toContain('DOCUMENTS:\n3.');
    expect(secondPrompt).not.toContain('0.');
  });

  it('keeps small sets in a single call below the prompt char budget', async () => {
    const docs = Array.from({ length: 7 }, (_, i) => `doc ${i}`);
    generateTextMock.mockResolvedValue(rateChunksResult([{ index: 0, relevant: true }]));
    const graders = createGraders();
    await graders.documentGrader.gradeAll('q', docs);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to lenient plain text once after repeated malformed tool args', async () => {
    generateTextMock
      .mockResolvedValueOnce(malformedResult()) // local provider ignored the forced choice
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ toolName: 'unrelated_tool', input: {} }],
      })
      .mockResolvedValueOnce({ text: 'I would say no.' });

    const before = getGraderFailureCounts().documentGraderFallback;
    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['a', 'b'])).toEqual(['no', 'no']);
    expect(getGraderFailureCounts().documentGraderFallback).toBe(before + 1);

    expect(generateTextMock).toHaveBeenCalledTimes(3);
    const fallbackCall = generateTextMock.mock.calls[2]![0];
    expect(fallbackCall.tools).toBeUndefined();
    expect(fallbackCall.toolChoice).toBeUndefined();
  });

  it('falls back to lenient plain text when a local provider ignores forced toolChoice entirely', async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: 'The first document seems helpful, yes.', toolCalls: [] })
      .mockResolvedValueOnce({ text: 'Still no tool call from me.', toolCalls: undefined })
      .mockResolvedValueOnce({ text: 'yes' });

    const graders = createGraders();
    expect(await graders.documentGrader.gradeAll('q', ['only doc'])).toEqual(['yes']);
    expect(getGraderFailureCounts().documentGraderFallback).toBeGreaterThan(0);
  });
});

describe('lenient text fallback parsing', () => {
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
    ['Yes, this document discusses the refund policy.', 'yes'],
    ['yess', 'yes'],
    ['123', 'yes'],
    ['uncertain', 'yes'],
    ['maybe', 'yes'],
    ['garbage text here', 'yes'],
    ['', 'yes'],
    ['n o', 'yes'],
    ['yes no', 'no'],
  ])('parses fallback reply %j to %j', async (text, expected) => {
    generateTextMock
      .mockResolvedValueOnce(malformedResult())
      .mockResolvedValueOnce(malformedResult())
      .mockResolvedValueOnce({ text });
    expect(await documentGrader.gradeAll('q', ['doc'])).toEqual([expected]);
  });
});

describe('hallucinationGrader', () => {
  it('returns yes when the tool reports grounded', async () => {
    generateTextMock.mockResolvedValue(groundedResult(true));
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
  });

  it("returns no when the tool explicitly reports grounded:false", async () => {
    generateTextMock.mockResolvedValue(groundedResult(false));
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('no');
  });

  it('forces the grounded_verdict tool and passes sources + answer', async () => {
    generateTextMock.mockResolvedValue(groundedResult(true));
    await hallucinationGrader.grade('DOC A', 'Generated answer text');

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.tools?.grounded_verdict).toBeDefined();
    expect(call.toolChoice).toBe('required');
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(String(call.system)).toContain('Ignore leading disclaimer preambles like');
    expect(String(call.system)).toContain('my best guess');
    const prompt = String(call.prompt);
    expect(prompt).toContain('BEGIN DOCUMENTS\nDOC A');
    expect(prompt).toContain('END DOCUMENTS');
    expect(prompt).toContain('GENERATED ANSWER:\nGenerated answer text');
  });

  it('THROWS after malformed output (intentional fail-open contract)', async () => {
    generateTextMock.mockResolvedValue({
      text: '',
      toolCalls: [{ toolName: 'grounded_verdict', input: { grounded: 'definitely' } }],
    });
    const before = getGraderFailureCounts().hallucinationGrader;
    await expect(hallucinationGrader.grade('docs', 'answer')).rejects.toThrow();
    expect(getGraderFailureCounts().hallucinationGrader).toBe(before + 1);
  });

  it('throws (never flips to grounded) on a persistent retryable outage', async () => {
    generateTextMock.mockRejectedValue(retryable);
    const before = getGraderFailureCounts().hallucinationGrader;
    await expect(hallucinationGrader.grade('docs', 'answer')).rejects.toThrow();
    expect(generateTextMock.mock.calls.length).toBeGreaterThan(1);
    expect(getGraderFailureCounts().hallucinationGrader).toBe(before + 1);
  });

  it('retries transient failures before returning a verdict', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce(groundedResult(true));
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('shared ~25s turn deadline', () => {
  it('returns null without an LLM call when the budget is exhausted at entry', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const graders = createGraders();
    generateTextMock.mockResolvedValue({ text: 'rewritten' });
    await graders.queryRewriter.rewrite('warmup'); // lazily starts the deadline

    vi.setSystemTime(start.getTime() + 26_000);
    const callsBefore = generateTextMock.mock.calls.length;
    expect(await graders.documentGrader.gradeAll('q', ['doc'])).toBeNull();
    expect(generateTextMock.mock.calls.length).toBe(callsBefore);
    expect(warnOutput()).toContain('grading_deadline_hit');
  });

  it('stops between sub-batches, logs subBatches attempted, and returns null', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const graders = createGraders();

    let call = 0;
    generateTextMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return rateChunksResult([
          { index: 0, relevant: true },
          { index: 1, relevant: false },
          { index: 2, relevant: true },
        ]);
      }
      vi.setSystemTime(start.getTime() + 26_000);
      return rateChunksResult([]);
    });

    const docs = Array.from(
      { length: 3 * GRADE_BATCH_DOCS },
      (_, i) => `${i}${'x'.repeat(GRADE_DOC_CHAR_CAP - 1)}`,
    ); // 27000 chars > GRADE_PROMPT_CHAR_BUDGET -> 3 sub-batches
    expect(await graders.documentGrader.gradeAll('q', docs)).toBeNull();
    expect(call).toBe(2); // two sub-batches ran before the budget cut batch three
    expect(warnOutput()).toContain('grading_deadline_hit');
    expect(warnOutput()).toContain('"subBatches":2');
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
    generateTextMock.mockResolvedValue(rateChunksResult([{ index: 0, relevant: true }]));
    await graders.documentGrader.gradeAll('q', ['doc']);
    expect(modelProvider).toHaveBeenCalledTimes(1);
    expect(getChatModelMock).not.toHaveBeenCalled();
  });

  it('passes the grade model override to the injected provider', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as (modelId?: string) => import('@ai-sdk/provider').LanguageModelV3;
    const graders = createGraders('custom-grade-model', modelProvider);
    generateTextMock.mockResolvedValue(groundedResult(false));
    await graders.hallucinationGrader.grade('docs', 'answer');
    expect(modelProvider).toHaveBeenCalledWith('custom-grade-model');
  });
});
