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
    hallucinationGrader: { grade: vi.fn() },
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

  it('retries with the original query when the first pass keeps nothing', async () => {
    searchChunksMock
      .mockResolvedValueOnce(ok([chunk('weak', 0.2)]))
      .mockResolvedValueOnce(ok([chunk('strong match', 0.85)]));
    graderMock
      .mockResolvedValueOnce('no')
      .mockResolvedValueOnce('yes');
    const res = await agenticSearch('the question', makeDeps());
    expect(res.ok).toBe(true);
    expect(searchChunksMock).toHaveBeenCalledTimes(2);
    expect(rewriterMock).toHaveBeenCalledWith('the question');
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
});
