import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, unwrap } from '@app/domain';
import { agenticSearch, type AgenticDeps } from './agentic-search';
import { SearchFailure, type SearchDegradation } from './search/search-contract';
import type { RetrievalDiagnostics } from './search';

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

function chunk(content: string, dense: number) {
  return {
    id: 1,
    documentId: 1,
    fileName: null,
    page: null,
    sectionTitle: null,
    source: null,
    title: null,
    content,
    chunkIndex: 0,
    scores: { dense, finalRank: 1, finalSignal: 'dense' as const },
  };
}

function searchResult(chunks: ReturnType<typeof chunk>[], degradedBy: SearchDegradation[] = []) {
  return { chunks, degradedBy, diagnostics: testDiagnostics(chunks.length) };
}

function testDiagnostics(finalCount: number): RetrievalDiagnostics {
  return {
    requestedLimit: finalCount,
    candidateLimit: finalCount,
    documentFilterApplied: false,
    dense: { status: 'ok', candidateCount: finalCount },
    lexical: { status: 'not_run', candidateCount: 0, mode: 'weighted_websearch' },
    fusion: { applied: false, inputCount: finalCount, outputCount: finalCount },
    reranker: {
      status: 'not_configured',
      inputCount: 0,
      validCount: 0,
      acceptedCount: 0,
      threshold: null,
      thresholdFilteredCount: 0,
    },
    resolutionMode: 'parent',
    resolvedCount: finalCount,
    stableDuplicatesSkipped: 0,
    backfillCount: 0,
    hasMore: false,
    finalCount,
    finalRanks: Array.from({ length: finalCount }, (_, index) => index + 1),
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
    searchChunksMock.mockResolvedValue(ok(searchResult(rows)));
    const res = await agenticSearch('vague question', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).toHaveBeenCalledWith('vague question');
    expect(r.chunks).toEqual(rows);
    expect(r.rewrittenQuery).toBe('rewritten query');
    expect(r.outOfDomain).toBe(false);
    expect(r.isEmpty).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('results');
    expect(r.attemptedQueries).toEqual(['rewritten query']);
    expect(r.resultQuery).toBe('rewritten query');
  });

  it('returns empty wall flags for an empty query without searching or rewriting', async () => {
    const res = await agenticSearch('   ', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.chunks).toEqual([]);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('no_match');
    expect(searchChunksMock).not.toHaveBeenCalled();
    expect(rewriterMock).not.toHaveBeenCalled();
  });

  it('echoes the original query when the rewriter throws and searches with it verbatim', async () => {
    rewriterMock.mockRejectedValue(new Error('boom'));
    searchChunksMock.mockResolvedValue(ok(searchResult([chunk('doc', 0.9)])));
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
    searchChunksMock.mockResolvedValue(ok(searchResult([chunk('doc', 0.9)])));
    const res = await agenticSearch('original wording', { ...makeDeps(), rewriteEnabled: false });
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).not.toHaveBeenCalled();
    expect(searchChunksMock).toHaveBeenCalledWith('original wording', expect.anything(), expect.anything());
    expect(r.rewrittenQuery).toBe('original wording');
    expect(r.resultState).toBe('results');
  });

  it('retries an empty pass with a fresh rewrite and keeps the recovered rows', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock
      .mockResolvedValueOnce(ok(searchResult([])))
      .mockResolvedValueOnce(ok(searchResult([chunk('strong match', 0.85)])));
    const res = await agenticSearch('the question', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(rewriterMock).toHaveBeenNthCalledWith(1, 'the question');
    expect(rewriterMock).toHaveBeenNthCalledWith(2, 'the question');
    expect(searchChunksMock).toHaveBeenNthCalledWith(
      2,
      'the question refined',
      expect.anything(),
      expect.anything(),
    );
    const r = unwrap(res);
    expect(r.chunks[0]!.content).toBe('strong match');
    expect(r.rewrittenQuery).toBe('the question refined');
    expect(r.resultState).toBe('results');
    expect(r.attemptedQueries).toEqual(['the question refined', 'the question refined']);
  });

  it('stops retrying once a pass returns rows even with retries still available', async () => {
    searchChunksMock.mockResolvedValue(ok(searchResult([chunk('doc', 0.9)])));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(1);
    expect(rewriterMock).toHaveBeenCalledTimes(1);
    expect(unwrap(res).resultState).toBe('results');
  });

  it('gives up after maxRetries empty passes and returns the empty wall flags', async () => {
    searchChunksMock.mockResolvedValue(ok(searchResult([])));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 2 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
    expect(rewriterMock).toHaveBeenCalledTimes(3);
    const r = unwrap(res);
    expect(r.chunks).toEqual([]);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('no_match');
  });

  it('retries once by default when no explicit maxRetries is given', async () => {
    searchChunksMock.mockResolvedValue(ok(searchResult([])));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(unwrap(res).resultState).toBe('no_match');
  });

  it('caps retries by the step budget', async () => {
    searchChunksMock.mockResolvedValue(ok(searchResult([])));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 5, stepBudget: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
    expect(unwrap(res).resultState).toBe('no_match');
  });

  it('preserves a typed failing inner search result', async () => {
    searchChunksMock.mockResolvedValue(err(new SearchFailure(
      'retrieval_unavailable',
      true,
      'The documentation search is temporarily unavailable. Please try again.',
    )));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('retrieval_unavailable');
      expect(res.error.attemptedQueries).toEqual(['rewritten query']);
    }
  });

  it('maps a thrown search failure to a typed retrieval error', async () => {
    searchChunksMock.mockRejectedValue(new Error('model down'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('retrieval_unavailable');
  });

  it('forwards all WP-2 retrieval controls into the inner searchChunks opts', async () => {
    searchChunksMock.mockResolvedValue(ok(searchResult([chunk('doc', 0.9)])));
    const excluded = new Set(['chunk_uid:seen']);
    const res = await agenticSearch('q', {
      ...makeDeps(),
      retrieveLimit: 25,
      similarityThreshold: 0.7,
      rerankerThreshold: 0.6,
      hybridEnabled: false,
      lexicalSearchMode: 'content_plain',
      filter: { documentId: 42 },
      excludeChunkIdentities: excluded,
    });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledWith(
      'rewritten query',
      expect.objectContaining({
        limit: 25,
        threshold: 0.7,
        rerankerThreshold: 0.6,
        hybridEnabled: false,
        lexicalSearchMode: 'content_plain',
        filter: { documentId: 42 },
        excludeChunkIdentities: excluded,
      }),
      expect.anything(),
    );
  });
});
