import { describe, it, expect, vi } from 'vitest';
import { searchChunks } from '../search';
import type { SearchDeps } from '../search';
import type { RetrievedChunkRow } from '@app/domain';

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
