import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { generateTextMock, getChatModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getChatModelMock: vi.fn(() => ({ modelId: 'mock-aux' })),
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

vi.mock('./model', async () => {
  const actual = await vi.importActual<typeof import('./model')>('./model');
  return { ...actual, getChatModel: getChatModelMock };
});

vi.mock('./retry', async () => {
  const actual = await vi.importActual<typeof import('./retry')>('./retry');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

import { createAuxModels } from './aux';
import { getAuxModels } from './index';
import type { ChatModelProvider } from './registries';

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  generateTextMock.mockReset();
  getChatModelMock.mockReset();
  getChatModelMock.mockReturnValue({ modelId: 'mock-aux' });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  vi.useRealTimers();
});

const retryable = Object.assign(new Error('rate limited'), { statusCode: 429 });

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

describe('queryRewriter', () => {
  it('returns the rewritten query from the model', async () => {
    generateTextMock.mockResolvedValue({ text: '  school cell phone policy  ' });
    const aux = createAuxModels();
    expect(await aux.queryRewriter.rewrite('phones at school')).toBe('school cell phone policy');
  });

  it('echoes the original query when the model returns empty', async () => {
    generateTextMock.mockResolvedValue({ text: '   ' });
    const aux = createAuxModels();
    expect(await aux.queryRewriter.rewrite('original')).toBe('original');
  });

  it('echoes the original query when the model call throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    const aux = createAuxModels();
    expect(await aux.queryRewriter.rewrite('original')).toBe('original');
  });

  it('retries transient failures before echoing the original query', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce({ text: 'tightened query' });
    const aux = createAuxModels();
    expect(await aux.queryRewriter.rewrite('original')).toBe('tightened query');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('echoes the original query without an LLM call when the shared turn budget is exhausted', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const aux = createAuxModels();
    generateTextMock.mockResolvedValue({ text: 'rewritten' });
    expect(await aux.queryRewriter.rewrite('first')).toBe('rewritten');

    vi.setSystemTime(start.getTime() + 26_000);
    const callsBefore = generateTextMock.mock.calls.length;
    expect(await aux.queryRewriter.rewrite('original')).toBe('original');
    expect(generateTextMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('hallucinationGrader', () => {
  it('returns yes when the tool reports grounded', async () => {
    generateTextMock.mockResolvedValue(groundedResult(true));
    const aux = createAuxModels();
    expect(await aux.hallucinationGrader.grade('docs', 'answer')).toBe('yes');
  });

  it("returns no when the tool explicitly reports grounded:false", async () => {
    generateTextMock.mockResolvedValue(groundedResult(false));
    const aux = createAuxModels();
    expect(await aux.hallucinationGrader.grade('docs', 'answer')).toBe('no');
  });

  it('forces the grounded_verdict tool and passes sources + answer', async () => {
    generateTextMock.mockResolvedValue(groundedResult(true));
    const aux = createAuxModels();
    await aux.hallucinationGrader.grade('DOC A', 'Generated answer text');

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
    const aux = createAuxModels();
    await expect(aux.hallucinationGrader.grade('docs', 'answer')).rejects.toThrow();
  });

  it('throws (never flips to grounded) on a persistent retryable outage', async () => {
    generateTextMock.mockRejectedValue(retryable);
    const aux = createAuxModels();
    await expect(aux.hallucinationGrader.grade('docs', 'answer')).rejects.toThrow();
    expect(generateTextMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('does NOT retry a deadline abort — single attempt then throw', async () => {
    const deadlineAbort = Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' });
    generateTextMock.mockRejectedValue(deadlineAbort);
    const aux = createAuxModels();
    await expect(aux.hallucinationGrader.grade('docs', 'answer')).rejects.toThrow();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('caps its abort window at the post-stream budget', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      generateTextMock.mockResolvedValue(groundedResult(true));
      const aux = createAuxModels();
      await aux.hallucinationGrader.grade('docs', 'answer');
      expect(timeoutSpy).toHaveBeenCalledWith(12_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('retries transient failures before returning a verdict', async () => {
    generateTextMock.mockRejectedValueOnce(retryable);
    generateTextMock.mockResolvedValueOnce(groundedResult(true));
    const aux = createAuxModels();
    expect(await aux.hallucinationGrader.grade('docs', 'answer')).toBe('yes');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

describe('getAuxModels selector', () => {
  it('returns undefined models when AGENTIC_ENABLED=false', async () => {
    const prev = process.env.AGENTIC_ENABLED;
    process.env.AGENTIC_ENABLED = 'false';
    const aux = getAuxModels();
    expect(aux.queryRewriter).toBeUndefined();
    expect(aux.hallucinationGrader).toBeUndefined();
    process.env.AGENTIC_ENABLED = prev ?? '';
  });

  it('returns the adapters when enabled', async () => {
    const prev = process.env.AGENTIC_ENABLED;
    delete process.env.AGENTIC_ENABLED;
    const aux = getAuxModels();
    expect(aux.queryRewriter).toBeDefined();
    expect(aux.hallucinationGrader).toBeDefined();
    process.env.AGENTIC_ENABLED = prev ?? '';
  });

  it('forwards the injected env to the model provider', async () => {
    const customEnv = { get: (key: string) => (key === 'AUX_MODEL' ? 'env-aux-model' : undefined) };
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as ChatModelProvider;
    generateTextMock.mockResolvedValue({ text: 'rewritten' });
    const aux = getAuxModels(true, undefined, modelProvider, customEnv);
    await aux.queryRewriter!.rewrite('q');
    expect(modelProvider).toHaveBeenCalledWith({ env: customEnv, modelId: 'env-aux-model' });
  });
});

describe('createAuxModels with an injected model provider', () => {
  it('uses the injected provider instead of the default chat model', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as ChatModelProvider;
    const aux = createAuxModels(undefined, modelProvider);
    generateTextMock.mockResolvedValue({ text: 'rewritten' });
    await aux.queryRewriter.rewrite('q');
    expect(modelProvider).toHaveBeenCalledTimes(1);
    expect(getChatModelMock).not.toHaveBeenCalled();
  });

  it('passes the aux model override to the injected provider', async () => {
    const modelProvider = vi.fn(() => ({ modelId: 'injected' })) as unknown as ChatModelProvider;
    const aux = createAuxModels('custom-aux-model', modelProvider);
    generateTextMock.mockResolvedValue(groundedResult(false));
    await aux.hallucinationGrader.grade('docs', 'answer');
    expect(modelProvider).toHaveBeenCalledWith({ env: expect.anything(), modelId: 'custom-aux-model' });
  });
});
