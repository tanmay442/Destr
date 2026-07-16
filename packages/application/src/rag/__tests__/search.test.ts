import { describe, it, expect, vi } from 'vitest';
import { searchChunks } from '../search';
import type { SearchDeps } from '../search';
import type { RankedDocument, RetrievedChunkRow } from '@app/domain';

function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
  return {
    chunks: {
      insertMany: vi.fn(),
      deleteByDocumentId: vi.fn(),
      searchByVector: vi.fn().mockResolvedValue([
        {
          id: 1,
          documentId: 1,
          fileName: 'test.pdf',
          page: null,
          sectionTitle: null,
          source: null,
          content: 'test',
          similarity: 0.9,
          parentChunkId: null,
        },
      ]),
      getByIds: vi.fn().mockResolvedValue([]),
      getByDocAndRange: vi.fn().mockResolvedValue([]),
      countForDocuments: vi.fn(),
      countForAll: vi.fn(),
      countForDocument: vi.fn(),
      recountAll: vi.fn(),
    },
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn(),
    },
    ...overrides,
  };
}

describe('searchChunks', () => {
  it('propagates DB errors as ExternalServiceError', async () => {
    const deps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockRejectedValue(new Error('connection refused')),
        getByIds: vi.fn(),
        getByDocAndRange: vi.fn(),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      },
    });
    const result = await searchChunks('test', {}, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Vector search failed/);
    }
  });

  it('returns empty array for blank query without embedding', async () => {
    const embed = vi.fn();
    const deps = makeDeps({
      embeddings: { embed, embedBatch: vi.fn() },
    });
    const result = await searchChunks('   ', {}, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns results on success', async () => {
    const deps = makeDeps();
    const result = await searchChunks('test', {}, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          id: 1,
          documentId: 1,
          fileName: 'test.pdf',
          page: null,
          sectionTitle: null,
          source: null,
          content: 'test',
          similarity: 0.9,
        },
      ]);
    }
  });
});

describe('searchChunks parent-child resolution', () => {
  function parentChildDeps(hits: RetrievedChunkRow[], parents: RetrievedChunkRow[]): SearchDeps {
    return {
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue(hits),
        getByIds: vi.fn().mockResolvedValue(parents),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      },
      embeddings: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), embedBatch: vi.fn() },
    };
  }

  it('returns parent content but keeps the child citation (parent mode)', async () => {
    const deps = parentChildDeps(
      [
        {
          id: 10,
          documentId: 1,
          fileName: 'd.pdf',
          page: 1,
          sectionTitle: 'Child Sec',
          source: 'Page 1 — Child Sec',
          content: 'child text',
          similarity: 0.9,
          parentChunkId: 5,
          chunkIndex: 3,
        },
      ],
      [
        {
          id: 5,
          documentId: 1,
          fileName: 'd.pdf',
          page: 1,
          sectionTitle: 'Parent Sec',
          source: 'Page 1 — Parent Sec',
          content: 'PARENT BLOCK CONTENT',
          similarity: 0,
          parentChunkId: null,
          chunkIndex: 0,
        },
      ],
    );
    const result = await searchChunks('q', {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        id: 5,
        documentId: 1,
        fileName: 'd.pdf',
        page: 1,
        sectionTitle: 'Child Sec',
        source: 'Page 1 — Child Sec',
        content: 'PARENT BLOCK CONTENT',
        similarity: 0.9,
      },
    ]);
  });

  it('falls back to the hit itself when it has no parentChunkId', async () => {
    const deps = parentChildDeps(
      [
        {
          id: 7,
          documentId: 1,
          fileName: 'd.pdf',
          page: 2,
          sectionTitle: null,
          source: null,
          content: 'flat chunk',
          similarity: 0.8,
          parentChunkId: null,
          chunkIndex: 9,
        },
      ],
      [],
    );
    const result = await searchChunks('q', {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        id: 7,
        documentId: 1,
        fileName: 'd.pdf',
        page: 2,
        sectionTitle: null,
        source: null,
        content: 'flat chunk',
        similarity: 0.8,
      },
    ]);
  });

  it('pads the hit with neighbouring chunks in window mode', async () => {
    const deps = parentChildDeps(
      [
        {
          id: 3,
          documentId: 1,
          fileName: 'd.pdf',
          page: 1,
          sectionTitle: null,
          source: null,
          content: 'middle',
          similarity: 0.95,
          parentChunkId: null,
          chunkIndex: 5,
        },
      ],
      [],
    );
    (deps.chunks.getByDocAndRange as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, documentId: 1, fileName: 'd.pdf', page: 1, sectionTitle: null, source: null, content: 'before', similarity: 0, parentChunkId: null, chunkIndex: 4 },
      { id: 3, documentId: 1, fileName: 'd.pdf', page: 1, sectionTitle: null, source: null, content: 'middle', similarity: 0, parentChunkId: null, chunkIndex: 5 },
      { id: 5, documentId: 1, fileName: 'd.pdf', page: 1, sectionTitle: null, source: null, content: 'after', similarity: 0, parentChunkId: null, chunkIndex: 6 },
    ]);
    const result = await searchChunks('q', { mode: 'window' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.content).toBe('before\n\nmiddle\n\nafter');
    expect(result.value[0]!.id).toBe(3);
  });
});

describe('searchChunks reranking', () => {
  function flatRow(id: number, content: string, similarity: number): RetrievedChunkRow {
    return {
      id,
      documentId: 1,
      fileName: 'd.pdf',
      page: null,
      sectionTitle: null,
      source: null,
      content,
      similarity,
      parentChunkId: null,
      chunkIndex: id,
    };
  }

  function rerankDeps(rows: RetrievedChunkRow[], rank: SearchDeps['reranker']): SearchDeps {
    return {
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue(rows),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      },
      embeddings: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), embedBatch: vi.fn() },
      reranker: rank,
    };
  }

  it('reorders candidates by reranker relevanceScore', async () => {
    const rows = [
      flatRow(1, 'first by cosine', 0.9),
      flatRow(2, 'second by cosine', 0.8),
      flatRow(3, 'third by cosine', 0.7),
    ];
    // Reranker prefers the reverse of the cosine order.
    const rank = vi.fn(async (_q: string, docs: string[]): Promise<RankedDocument[]> =>
      docs.map((_d, index) => ({ index, relevanceScore: index })),
    );
    const deps = rerankDeps(rows, { rank });

    const result = await searchChunks('q', { limit: 3 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rank).toHaveBeenCalledWith('q', ['first by cosine', 'second by cosine', 'third by cosine']);
    expect(result.value.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('slices reranked results to the requested topN', async () => {
    const rows = [
      flatRow(1, 'a', 0.5),
      flatRow(2, 'b', 0.5),
      flatRow(3, 'c', 0.5),
      flatRow(4, 'd', 0.5),
      flatRow(5, 'e', 0.5),
    ];
    const rank = vi.fn(async (_q: string, docs: string[]): Promise<RankedDocument[]> =>
      docs.map((_d, index) => ({ index, relevanceScore: docs.length - index })),
    );
    const deps = rerankDeps(rows, { rank });

    const result = await searchChunks('q', { limit: 2 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toEqual([1, 2]);
  });

  it('retrieves a broad candidate pool with no cosine cutoff when reranking', async () => {
    const rows = [flatRow(1, 'a', 0.1)];
    const searchByVector = vi.fn().mockResolvedValue(rows);
    const rank = vi.fn(async (_q: string, docs: string[]): Promise<RankedDocument[]> =>
      docs.map((_d, index) => ({ index, relevanceScore: 1 })),
    );
    const deps: SearchDeps = {
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector,
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      },
      embeddings: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), embedBatch: vi.fn() },
      reranker: { rank },
    };

    await searchChunks('q', { candidateLimit: 30 }, deps);
    expect(searchByVector).toHaveBeenCalledWith([0.1, 0.2, 0.3], { threshold: 0, limit: 30 });
  });

  it('falls back to cosine ordering when the reranker throws', async () => {
    const rows = [
      flatRow(1, 'a', 0.3),
      flatRow(2, 'b', 0.9),
      flatRow(3, 'c', 0.6),
    ];
    const rank = vi.fn().mockRejectedValue(new Error('model load failed'));
    const deps = rerankDeps(rows, { rank });

    const result = await searchChunks('q', { limit: 3 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Highest cosine similarity first.
    expect(result.value.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it('uses the original cosine path when no reranker is configured (default cosine mode)', async () => {
    const rows = [
      flatRow(1, 'a', 0.3),
      flatRow(2, 'b', 0.9),
      flatRow(3, 'c', 0.6),
    ];
    // No `reranker` key — equivalent to RERANKER_PROVIDER=cosine (default).
    const deps = rerankDeps(rows, undefined);
    const result = await searchChunks('q', { limit: 3 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Original pre-S6 bi-encoder ordering (highest similarity first), no rerank call.
    expect(result.value.map((r) => r.id)).toEqual([2, 3, 1]);
  });
});
