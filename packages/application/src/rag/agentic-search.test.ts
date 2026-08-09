import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, unwrap } from '@app/domain';
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
    documentGrader: { grade: graderMock },
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
  it('rewrites the query, retrieves, and keeps only graded-relevant chunks', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('relevant doc', 0.9), chunk('off topic', 0.1)]));
    graderMock.mockImplementation(async (_q: string, doc: string) =>
      doc === 'relevant doc' ? 'yes' : 'no',
    );
    const res = await agenticSearch('vague question', makeDeps());
    expect(res.ok).toBe(true);
    const r = unwrap(res);
    expect(rewriterMock).toHaveBeenCalledWith('vague question');
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.content).toBe('relevant doc');
    expect(r.rewrittenQuery).toBe('rewritten query');
    expect(r.outOfDomain).toBe(false);
  });

  it('drops all chunks and flags out-of-domain when similarity is below threshold', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('unrelated', 0.1)]));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('anything', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).chunks).toHaveLength(0);
    expect(unwrap(res).outOfDomain).toBe(true);
  });

  it('retries by feeding the previous rewrite back into the rewriter', async () => {
    rewriterMock.mockImplementation(async (q: string) => `${q} refined`);
    searchChunksMock
      .mockResolvedValueOnce(ok([chunk('weak', 0.2)]))
      .mockResolvedValueOnce(ok([chunk('strong match', 0.85)]));
    graderMock
      .mockResolvedValueOnce('no')
      .mockResolvedValueOnce('yes');
    const res = await agenticSearch('the question', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(rewriterMock).toHaveBeenNthCalledWith(1, 'the question');
    expect(rewriterMock).toHaveBeenNthCalledWith(2, 'the question refined');
    expect(unwrap(res).chunks).toHaveLength(1);
    expect(unwrap(res).chunks[0]!.content).toBe('strong match');
  });

  it('returns empty + out-of-domain for an empty query', async () => {
    const res = await agenticSearch('   ', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).chunks).toHaveLength(0);
    expect(unwrap(res).outOfDomain).toBe(true);
    expect(searchChunksMock).not.toHaveBeenCalled();
  });

  it('echoes the original query when the rewriter throws', async () => {
    rewriterMock.mockRejectedValue(new Error('boom'));
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.9)]));
    graderMock.mockResolvedValue('yes');
    const res = await agenticSearch('original wording', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).rewrittenQuery).toBe('original wording');
  });

  it('threads runtime retrieveLimit and maxRetries knobs', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('weak', 0.2)]));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', { ...makeDeps(), retrieveLimit: 25, maxRetries: 2 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledWith('rewritten query', { limit: 25 }, expect.anything());
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
  });

  it('caps retries by the step budget', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('weak', 0.2)]));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 5, stepBudget: 3 });
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(3);
  });

  it('enforces a hard total grader-call budget across the whole turn (M5)', async () => {
    searchChunksMock.mockResolvedValue(ok(Array.from({ length: 6 }, (_, i) => chunk(`doc ${i}`, 0.1))));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', { ...makeDeps(), stepBudget: 4 });
    expect(res.ok).toBe(true);
    expect(graderMock).toHaveBeenCalledTimes(4);
    expect(unwrap(res).chunks).toHaveLength(0);
    expect(unwrap(res).outOfDomain).toBe(true);
  });

  it('grades the retrieved pool with bounded concurrency', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => chunk(`doc ${i}`, 0.9));
    let inflight = 0;
    let peak = 0;
    searchChunksMock.mockResolvedValue(ok(rows));
    graderMock.mockImplementation(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return 'yes';
    });
    const res = await agenticSearch('q', { ...makeDeps(), maxRetries: 0 });
    expect(res.ok).toBe(true);
    expect(unwrap(res).chunks).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('still retries when the first pass fills the retrieval limit (M5 default knobs)', async () => {
    // Defaults: stepBudget 8, retrieveLimit 10, maxRetries 1. The first pass
    // grades 4 rows and must leave room for a retry pass instead of spending
    // the whole budget up front.
    searchChunksMock.mockResolvedValue(ok(Array.from({ length: 10 }, (_, i) => chunk(`doc ${i}`, 0.2))));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(graderMock).toHaveBeenCalledTimes(8);
    expect(unwrap(res).chunks).toHaveLength(0);
    expect(unwrap(res).outOfDomain).toBe(true);
  });

  it('ignores ungraded rows when deciding out-of-domain (M5)', async () => {
    // 8 low-similarity rows are graded across both passes; the 2 high-similarity
    // rows fall outside the budget and were never graded, so they must not
    // suppress the out-of-domain flag.
    searchChunksMock.mockResolvedValue(
      ok([
        ...Array.from({ length: 8 }, (_, i) => chunk(`doc ${i}`, 0.1)),
        chunk('high sim ungraded', 0.99),
        chunk('high sim ungraded 2', 0.98),
      ]),
    );
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).chunks).toHaveLength(0);
    expect(unwrap(res).outOfDomain).toBe(true);
  });

  it('keeps a chunk when its grader call throws instead of aborting the search', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.8)]));
    graderMock.mockRejectedValue(new Error('model down'));
    const res = await agenticSearch('q', makeDeps());
    expect(res.ok).toBe(true);
    expect(unwrap(res).chunks).toHaveLength(1);
    expect(unwrap(res).chunks[0]!.content).toBe('doc');
  });

  it('flags out-of-domain against a runtime outOfDomainThreshold', async () => {
    searchChunksMock.mockResolvedValue(ok([chunk('doc', 0.6)]));
    graderMock.mockResolvedValue('no');
    const res = await agenticSearch('q', { ...makeDeps(), outOfDomainThreshold: 0.9 });
    expect(res.ok).toBe(true);
    expect(unwrap(res).outOfDomain).toBe(true);
  });
});
