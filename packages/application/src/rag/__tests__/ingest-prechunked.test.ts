import { describe, it, expect, vi } from 'vitest';
import { ingestPrechunked, type PrechunkedIngestDeps } from '../ingest-prechunked';
import type { ParsedChunk } from '@app/domain';

function makeDeps(overrides?: Partial<PrechunkedIngestDeps>): PrechunkedIngestDeps {
  const insertMany = vi.fn().mockResolvedValue(undefined);
  const embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  const blobStorage = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    stream: vi.fn(),
    delete: vi.fn(),
  };
  return {
    documents: {
      findByName: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      setStorageKey: vi.fn().mockResolvedValue(undefined),
      updateIngestStatus: vi.fn(),
      claimIngest: vi.fn(),
      insert: vi.fn().mockResolvedValue({ id: 1, fileName: 'doc.md', fileHash: 'abc', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
      update: vi.fn().mockResolvedValue({ id: 1, fileName: 'doc.md', fileHash: 'abc', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
      deleteById: vi.fn(),
      softDelete: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      countChunksForDocuments: vi.fn().mockResolvedValue(new Map()),
      countChunksForAll: vi.fn().mockResolvedValue(0),
    },
    chunks: {
      insertMany,
      deleteByDocumentId: vi.fn().mockResolvedValue(undefined),
      searchByVector: vi.fn(),
      searchByLexical: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([]),
      getByDocAndRange: vi.fn().mockResolvedValue([]),
      getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
      countForDocuments: vi.fn(),
      countForAll: vi.fn(),
      countForDocument: vi.fn(),
      recountAll: vi.fn(),
    },
    embeddings: { embed: vi.fn(), embedBatch },
    hasher: { sha256: vi.fn().mockReturnValue('hash-123') },
    blobStorage,
    ...overrides,
  };
}

const CHUNKS: ParsedChunk[] = [
  { content: 'Getting started body.', page: 1, sectionTitle: 'Getting Started', source: 'manual.pdf' },
  { content: 'Auth body.', page: 2, sectionTitle: 'Authentication', source: null },
];

describe('ingestPrechunked', () => {
  it('embeds and writes chunks with metadata', async () => {
    const deps = makeDeps();
    const result = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('inserted');
    expect(result.value.chunks).toBe(2);
    expect(deps.chunks.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        documentId: 1,
        content: 'Getting started body.',
        embedding: [0.1, 0.2, 0.3],
        chunkIndex: 0,
        page: 1,
        sectionTitle: 'Getting Started',
        source: 'manual.pdf',
      }),
      expect.objectContaining({
        documentId: 1,
        content: 'Auth body.',
        embedding: [0.4, 0.5, 0.6],
        chunkIndex: 1,
        page: 2,
        sectionTitle: 'Authentication',
        source: null,
      }),
    ]);
  });

  it('stores the companion PDF blob only when provided', async () => {
    const deps = makeDeps();
    const pdf = Buffer.from('%PDF-1.4');
    await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
      deps,
    );
    expect(deps.blobStorage!.put).toHaveBeenCalledWith(
      expect.stringContaining('docs/1/doc.pdf'),
      pdf,
      'application/pdf',
    );
    expect(deps.documents.setStorageKey).toHaveBeenCalledWith(1, expect.stringContaining('docs/1/doc.pdf'));

    const depsNoPdf = makeDeps();
    await ingestPrechunked({ fileName: 'doc2.md', chunks: CHUNKS, uploadedBy: 'user' }, depsNoPdf);
    expect(depsNoPdf.blobStorage!.put).not.toHaveBeenCalled();
    expect(depsNoPdf.documents.setStorageKey).not.toHaveBeenCalled();
  });

  it('returns unchanged when the hash matches an existing document', async () => {
    const deps = makeDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({ id: 1, fileName: 'doc.md', fileHash: 'hash-123', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
        findById: vi.fn(),
        setStorageKey: vi.fn(),
        updateIngestStatus: vi.fn(),
        claimIngest: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        deleteById: vi.fn(),
        softDelete: vi.fn(),
        restore: vi.fn(),
        list: vi.fn(),
        countChunksForDocuments: vi.fn(),
        countChunksForAll: vi.fn(),
      },
    });
    const result = await ingestPrechunked({ fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user' }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('unchanged');
    expect(deps.chunks.insertMany).not.toHaveBeenCalled();
  });

  it('returns ValidationError when there are no chunks', async () => {
    const deps = makeDeps();
    const result = await ingestPrechunked({ fileName: 'empty.md', chunks: [], uploadedBy: 'user' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/No chunks/);
  });

  it('returns ExternalServiceError when embedding fails', async () => {
    const deps = makeDeps({
      embeddings: { embed: vi.fn(), embedBatch: vi.fn().mockRejectedValue(new Error('API down')) },
    });
    const result = await ingestPrechunked({ fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Embedding API failed/);
  });
});
