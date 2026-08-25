import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, unwrap, ExternalServiceError } from '@app/domain';
import { agenticSearch, type AgenticDeps } from './agentic-search';

const { searchChunksMock, rewriterMock } = vi.hoisted(() => ({
  searchChunksMock: vi.fn(),
  rewriterMock: vi.fn(),
}));

vi.mock('./search', () => ({
  searchChunks: (...args: unknown[]) => searchChunksMock(...args),
}));

function makeDeps(): AgenticDeps {
  return {
    search: {} as AgenticDeps['search'],
    queryRewriter: { rewrite: rewriterMock },
  };
}

function chunk(content: string, similarity: number) {
  return {
    id: 1,
    documentId: 1,
    fileName: null,
    page: null,
    sectionTitle: null,
    source: null,
    title: null,
    content,
    similarity,
  };
}

beforeEach(() => {
  searchChunksMock.mockReset();
  rewriterMock.mockReset();
  rewriterMock.mockResolvedValue('rewritten query');
});

describe('agenticSearch', () => {
  it('keeps every row returned by the pass unfiltered and flags a clean ok result', async () => {
    const rows = [chunk('relevant doc', 0.9), chunk('low-similarity doc kept anyway', 0.1)];
    searchChunksMock.mockResolvedValue(ok(rows));
    const res = await agenticSearch('vague question', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).toHaveBeenCalledWith('vague question');
    expect(r.chunks).toEqual(rows);
    expect(r.rewrittenQuery).toBe('rewritten query');
    expect(r.outOfDomain).toBe(false);
    expect(r.isEmpty).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('ok');
  });

  it('returns empty wall flags for an empty query without searching or rewriting', async () => {
    const res = await agenticSearch('   ', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.chunks).toEqual([]);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('empty');
    expect(searchChunksMock).not.toHaveBeenCalled();
    expect(rewriterMock).not.toHaveBeenCalled();
  });

  it('echoes the original query when the rewriter throws and searches with it verbatim', async () => {
    rewriterMock.mockRejectedValue(new Error('boom'));
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    const res = await agenticSearch('original wording', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.rewrittenQuery).toBe('original wording');
    expect(searchChunksMock).toHaveBeenCalledWith(
      'original wording',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rewrite off skips tryRewrite and uses the original query verbatim', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    const res = await agenticSearch('original wording', { ...makeDeps(), rewriteEnabled: false });
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).not.toHaveBeenCalled();
    expect(searchChunksMock).toHaveBeenCalledWith('original wording', expect.anything(), expect.anything());
    expect(r.rewrittenQuery).toBe('original wording');
    expect(r.resultState).toBe('ok');
  });

  it('retries an empty pass with a fresh rewrite and keeps the recovered rows', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([chunk('strong match', 0.85)]));
    const res = await agenticSearch('the question', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(rewriterMock).toHaveBeenNthCalledWith(1, 'the question');
    expect(rewriterMock).toHaveBeenNthCalledWith(2, 'the question refined');
    expect(searchChunksMock).toHaveBeenNthCalledWith(
      2,
      'the question refined refined',
      expect.anything(),
      expect.anything(),
    );
    const r = unwrap(res);
    expect(r.chunks[0]!.content).toBe('strong match');
    expect(r.rewrittenQuery).toBe('the question refined refined');
    expect(r.resultState).toBe('ok');
  });

  it('stops retrying once a pass returns rows even with retries still available', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(1);
    expect(rewriterMock).toHaveBeenCalledTimes(1);
    expect(unwrap(res).resultState).toBe('ok');
  });

  it('gives up after maxRetries empty passes and returns the empty wall flags', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 2 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3); // initial pass + 2 retries
    expect(rewriterMock).toHaveBeenCalledTimes(3);
    const r = unwrap(res);
    expect(r.chunks).toEqual([]);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('empty');
  });

  it('retries once by default when no explicit maxRetries is given', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(unwrap(res).resultState).toBe('empty');
  });

  it('caps retries by the step budget', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 5, stepBudget: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3); // 1 initial pass + min(maxRetries, budget - 1) retries
    expect(unwrap(res).resultState).toBe('empty');
  });

  it('wraps a failing inner search result into an ExternalServiceError', async () => {
    searchChunksMock.mockResolvedValue(err(new Error('db down')));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ExternalServiceError);
  });

  it('wraps a thrown search failure into an ExternalServiceError', async () => {
    searchChunksMock.mockRejectedValue(new Error('model down'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ExternalServiceError);
  });

  it('forwards similarityThreshold and hybridEnabled into the inner searchChunks opts', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    const res = await agenticSearch('q', {
      ...makeDeps(),
      retrieveLimit: 25,
      similarityThreshold: 0.7,
      hybridEnabled: false,
    });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledWith(
      'rewritten query',
      { limit: 25, threshold: 0.7, hybridEnabled: false },
      expect.anything(),
    );
  });
});
