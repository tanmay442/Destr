import { describe, it, expect, vi } from 'vitest';
import { ingestFile } from '../ingest';
import type { IngestDeps } from '../ingest';

function makeDeps(overrides?: Partial<IngestDeps>): IngestDeps {
  const insertMany = vi.fn().mockResolvedValue(undefined);
  const embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
  return {
    documents: {
      findByName: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      setStorageKey: vi.fn(),
      updateIngestStatus: vi.fn(),
      insert: vi.fn().mockResolvedValue({ id: 1, fileName: 'test.pdf', fileHash: 'abc', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
      deleteById: vi.fn(),
      softDelete: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      countChunksForDocuments: vi.fn().mockResolvedValue(new Map()),
      countChunksForAll: vi.fn().mockResolvedValue(0),
    },
    chunks: {
      insertMany,
      searchByVector: vi.fn(),
      countForDocuments: vi.fn(),
      countForAll: vi.fn(),
      countForDocument: vi.fn(),
      recountAll: vi.fn(),
    },
    embeddings: {
      embed: vi.fn(),
      embedBatch,
    },
    hasher: { sha256: vi.fn().mockReturnValue('abc123') },
    pdfParser: { extractText: vi.fn().mockResolvedValue('Sample PDF text content.') },
    textSplitter: { splitText: vi.fn().mockResolvedValue(['Sample PDF text content.']) },
    ...overrides,
  };
}

describe('ingestFile', () => {
  it('inserts chunks when embedding succeeds', async () => {
    const deps = makeDeps();
    const result = await ingestFile(
      { fileName: 'test.pdf', buffer: Buffer.from('%PDF-1.4...'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('inserted');
      expect(result.value.chunks).toBe(1);
    }
    expect(deps.chunks.insertMany).toHaveBeenCalledWith([
      { documentId: 1, content: 'Sample PDF text content.', embedding: [0.1, 0.2, 0.3] },
    ]);
  });

  it('deletes old document only after new insert succeeds', async () => {
    const deleteById = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockResolvedValue({ id: 2, fileName: 'test.pdf', fileHash: 'newhash', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null });
    const deps = makeDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({ id: 1, fileName: 'test.pdf', fileHash: 'oldhash', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
        findById: vi.fn(),
        setStorageKey: vi.fn(),
        updateIngestStatus: vi.fn(),
        insert,
        deleteById,
        softDelete: vi.fn(),
        restore: vi.fn(),
        list: vi.fn(),
        countChunksForDocuments: vi.fn().mockResolvedValue(new Map()),
        countChunksForAll: vi.fn().mockResolvedValue(0),
      },
    });
    const result = await ingestFile(
      { fileName: 'test.pdf', buffer: Buffer.from('%PDF-1.4...'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deleteById).toHaveBeenCalledBefore(insert);
  });

  it('returns unchanged when hash matches', async () => {
    const deps = makeDeps({
      documents: {
        ...makeDeps().documents,
        findByName: vi.fn().mockResolvedValue({ id: 1, fileName: 'test.pdf', fileHash: 'abc123', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
      },
    });
    const result = await ingestFile(
      { fileName: 'test.pdf', buffer: Buffer.from('data'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('unchanged');
    }
  });

  it('returns ValidationError when PDF has no extractable text', async () => {
    const deps = makeDeps({
      textSplitter: { splitText: vi.fn().mockResolvedValue([]) },
    });
    const result = await ingestFile(
      { fileName: 'empty.pdf', buffer: Buffer.from('data'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/No extractable text/);
    }
  });

  it('returns ExternalServiceError when PDF parsing fails', async () => {
    const deps = makeDeps({
      pdfParser: { extractText: vi.fn().mockRejectedValue(new Error('corrupt file')) },
    });
    const result = await ingestFile(
      { fileName: 'bad.pdf', buffer: Buffer.from('trash'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/PDF parsing failed/);
    }
  });

  it('returns ExternalServiceError when embedding fails', async () => {
    const deps = makeDeps({
      embeddings: { embed: vi.fn(), embedBatch: vi.fn().mockRejectedValue(new Error('API down')) },
    });
    const result = await ingestFile(
      { fileName: 'test.pdf', buffer: Buffer.from('data'), uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Embedding API failed/);
    }
  });
});
