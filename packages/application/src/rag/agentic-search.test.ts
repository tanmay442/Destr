import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, unwrap, GRADE_MAX_ROWS, logger } from '@app/domain';
import { agenticSearch, type AgenticDeps } from './agentic-search';

const { searchChunksMock, rewriterMock, graderMock } = vi.hoisted(() => ({
  searchChunksMock: vi.fn(),
  rewriterMock: vi.fn(),
  graderMock: vi.fn(),
}));

vi.mock('./search', () => ({
  searchChunks: (...args: unknown[]) => searchChunksMock(...args),
}));

function makeDeps(): AgenticDeps {
  return {
    search: {} as AgenticDeps['search'],
    queryRewriter: { rewrite: rewriterMock },
    documentGrader: { gradeAll: graderMock },
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
  graderMock.mockReset();
  rewriterMock.mockResolvedValue('rewritten query');
});

describe('agenticSearch', () => {
  it('rewrites the query, grades the pool in one batched call, and keeps relevant chunks', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('relevant doc', 0.9), chunk('off topic', 0.1)]));
    graderMock.mockImplementation(async (_q: string, docs: string[]) =>
      docs.map((d) => (d === 'relevant doc' ? 'yes' : 'no')),
    );
    const res = await agenticSearch('vague question', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).toHaveBeenCalledWith('vague question');
    expect(graderMock).toHaveBeenCalledTimes(1);
    expect(graderMock).toHaveBeenCalledWith('rewritten query', ['relevant doc', 'off topic']);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.content).toBe('relevant doc');
    expect(r.rewrittenQuery).toBe('rewritten query');
    expect(r.outOfDomain).toBe(false);
    expect(r.isEmpty).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('ok');
    expect(r.gradingUnavailable).toBe(false);
  });

  it('grades the full pool up to GRADE_MAX_ROWS; tail rows never reach the grader', async () => {
    const rows = Array.from({ length: GRADE_MAX_ROWS + 3 }, (_, i) => chunk(`doc ${i}`, 0.9));
    searchChunksMock.mockResolvedValue(ok(rows));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'yes'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(graderMock).toHaveBeenCalledTimes(1);
    expect(graderMock).toHaveBeenCalledWith(
      'rewritten query',
      rows.slice(0, GRADE_MAX_ROWS).map((r) => r.content),
    );
    expect(unwrap(res).chunks).toHaveLength(GRADE_MAX_ROWS);
    expect(unwrap(res).resultState).toBe('ok');
  });

  it('grader outage returns exactly the top-4 fallback chunks with degraded flags', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => chunk(`doc ${i}`, 0.9));
    searchChunksMock.mockResolvedValue(ok(rows));
    graderMock.mockResolvedValue(null);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const res = await agenticSearch('q', makeDeps());
      expect(res.ok).toBe(true);
      const r = unwrap(res);
      expect(r.chunks.map((c) => c.content)).toEqual(['doc 0', 'doc 1', 'doc 2', 'doc 3']);
      expect(r.degraded).toBe(true);
      expect(r.fallbackReason).toBe('grader_unavailable');
      expect(r.gradingUnavailable).toBe(true);
      expect(r.outOfDomain).toBe(false);
      expect(r.isEmpty).toBe(false);
      expect(r.resultState).toBe('degraded');
      const degradedWarns = warnSpy.mock.calls.filter((c) => c[1] && (c[1] as { event?: string }).event === 'agentic.degraded_fallback');
      expect(degradedWarns).toHaveLength(1);
      expect((degradedWarns[0]![1] as { fallbackReason: string }).fallbackReason).toBe('grader_unavailable');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('genuine all-no returns top-4 fallback flagged all_filtered, not an empty wall', async () => {
    searchChunksMock.mockResolvedValue(ok(Array.from({ length: 5 }, (_, i) => chunk(`doc ${i}`, 0.9))));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'no'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.chunks.map((c) => c.content)).toEqual(['doc 0', 'doc 1', 'doc 2', 'doc 3']);
    expect(r.degraded).toBe(true);
    expect(r.fallbackReason).toBe('all_filtered');
    expect(r.gradingUnavailable).toBe(false);
    expect(r.outOfDomain).toBe(false);
    expect(r.isEmpty).toBe(false);
    expect(r.resultState).toBe('degraded');
  });

  it('treats a thrown gradeAll call as a grader outage (fail open)', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.8), chunk('doc2', 0.7)]));
    graderMock.mockRejectedValue(new Error('model down'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.degraded).toBe(true);
    expect(r.fallbackReason).toBe('grader_unavailable');
    expect(r.chunks).toHaveLength(2);
    expect(r.isEmpty).toBe(false);
  });

  it('returns empty wall flags when search found 0 rows (only true empty case)', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('nonsense', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.chunks).toEqual([]);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.fallbackReason).toBeNull();
    expect(r.resultState).toBe('empty');
    expect(graderMock).not.toHaveBeenCalled();
  });

  it('grading toggle off skips gradeAll entirely and returns top-4 fused rows', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => chunk(`doc ${i}`, 0.9));
    searchChunksMock.mockResolvedValue(ok(rows));
    const res = await agenticSearch('q', { ...makeDeps(), gradeEnabled: false });
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(graderMock).not.toHaveBeenCalled();
    expect(r.chunks.map((c) => c.content)).toEqual(['doc 0', 'doc 1', 'doc 2', 'doc 3']);
    expect(r.degraded).toBe(true);
    expect(r.fallbackReason).toBe('grading_disabled');
    expect(r.outOfDomain).toBe(false);
    expect(r.isEmpty).toBe(false);
    expect(r.resultState).toBe('degraded');
  });

  it('rewrite off skips tryRewrite and uses the original query verbatim', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'yes'));
    const res = await agenticSearch('original wording', { ...makeDeps(), rewriteEnabled: false });
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).not.toHaveBeenCalled();
    expect(searchChunksMock).toHaveBeenCalledWith('original wording', expect.anything(), expect.anything());
    expect(r.rewrittenQuery).toBe('original wording');
    expect(r.resultState).toBe('ok');
  });

  it('forwards similarityThreshold and hybridEnabled into the inner searchChunks opts', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'yes'));
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

  it('retries while a pass found zero chunks and grading is enabled', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([chunk('strong match', 0.85)]));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'yes'));
    const res = await agenticSearch('the question', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(rewriterMock).toHaveBeenNthCalledWith(1, 'the question');
    expect(rewriterMock).toHaveBeenNthCalledWith(2, 'the question refined');
    const r = unwrap(res);
    expect(r.chunks[0]!.content).toBe('strong match');
    expect(r.resultState).toBe('ok');
  });

  it('retry loop stays inert when a pass ends degraded (outage emits fallback immediately)', async () => {
    searchChunksMock.mockResolvedValue(ok(Array.from({ length: 5 }, (_, i) => chunk(`doc ${i}`, 0.9))));
    graderMock.mockResolvedValue(null);
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(1);
    expect(graderMock).toHaveBeenCalledTimes(1);
    expect(unwrap(res).fallbackReason).toBe('grader_unavailable');
  });

  it('retries an all_filtered pass and ends degraded with that reason when grading stays all-no', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.4)]));
    graderMock.mockResolvedValue(['no']);
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 2 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
    expect(rewriterMock).toHaveBeenCalledTimes(3);
    expect(rewriterMock).toHaveBeenNthCalledWith(1, 'q');
    const r = unwrap(res);
    expect(r.degraded).toBe(true);
    expect(r.fallbackReason).toBe('all_filtered');
  });

  it('recovers to ok when a retried pass grades chunks relevant after an all_filtered first pass', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.4)]));
    graderMock.mockResolvedValueOnce(['no']).mockResolvedValueOnce(['yes']);
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    const r = unwrap(res);
    expect(r.resultState).toBe('ok');
    expect(r.degraded).toBe(false);
    expect(r.chunks[0]!.content).toBe('doc');
  });

  it('does not retry when grading is disabled even if search came back empty', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('q', { ...makeDeps(), gradeEnabled: false, maxRetries: 2 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(1);
    expect(unwrap(res).resultState).toBe('empty');
  });

  it('caps retries by the step budget', async () => {
    searchChunksMock.mockResolvedValue(ok([]));
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 5, stepBudget: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
    expect(unwrap(res).resultState).toBe('empty');
  });

  it('returns empty wall flags for an empty query without searching', async () => {
    const res = await agenticSearch('   ', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(r.chunks).toHaveLength(0);
    expect(r.outOfDomain).toBe(true);
    expect(r.isEmpty).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.resultState).toBe('empty');
    expect(searchChunksMock).not.toHaveBeenCalled();
  });

  it('echoes the original query when the rewriter throws', async () => {
    rewriterMock.mockRejectedValue(new Error('boom'));
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    graderMock.mockImplementation(async (_q: string, docs: string[]) => docs.map(() => 'yes'));
    const res = await agenticSearch('original wording', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).rewrittenQuery).toBe('original wording');
  });
});
