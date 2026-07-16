import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, ExternalServiceError } from '@app/domain';

const { generateTextMock, generateObjectMock, getChatModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  generateObjectMock: vi.fn(),
  getChatModelMock: vi.fn(() => ({ modelId: 'mock-grade' })),
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: generateTextMock,
    generateObject: generateObjectMock,
  };
});

vi.mock('./index', async () => {
  const actual = await vi.importActual<typeof import('./index')>('./index');
  return { ...actual, getChatModel: getChatModelMock };
});

import { queryRewriter, documentGrader, hallucinationGrader } from './graders';
import { getGraders } from './index';

beforeEach(() => {
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
  getChatModelMock.mockReturnValue({ modelId: 'mock-grade' });
});

describe('queryRewriter', () => {
  it('returns the rewritten query from the model', async () => {
    generateTextMock.mockResolvedValue({ text: '  school cell phone policy  ' });
    expect(await queryRewriter.rewrite('phones at school')).toBe('school cell phone policy');
  });

  it('echoes the original query when the model returns empty', async () => {
    generateTextMock.mockResolvedValue({ text: '   ' });
    expect(await queryRewriter.rewrite('original')).toBe('original');
  });

  it('echoes the original query when the model call throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    expect(await queryRewriter.rewrite('original')).toBe('original');
  });
});

describe('documentGrader', () => {
  it('returns yes when the model grades relevant', async () => {
    generateObjectMock.mockResolvedValue({ object: { relevant: 'yes' } });
    expect(await documentGrader.grade('q', 'doc')).toBe('yes');
  });

  it('returns no when the model grades irrelevant', async () => {
    generateObjectMock.mockResolvedValue({ object: { relevant: 'no' } });
    expect(await documentGrader.grade('q', 'doc')).toBe('no');
  });

  it('defaults to yes when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('boom'));
    expect(await documentGrader.grade('q', 'doc')).toBe('yes');
  });
});

describe('hallucinationGrader', () => {
  it('returns yes when the answer is grounded', async () => {
    generateObjectMock.mockResolvedValue({ object: { grounded: 'yes' } });
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
  });

  it('returns no when the answer is not grounded', async () => {
    generateObjectMock.mockResolvedValue({ object: { grounded: 'no' } });
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('no');
  });

  it('defaults to yes (grounded) when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('boom'));
    expect(await hallucinationGrader.grade('docs', 'answer')).toBe('yes');
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

void ok;
void err;
void ExternalServiceError;
