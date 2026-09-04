import { describe, it, expect, vi } from 'vitest';
import { ingestPrechunked, type PrechunkedIngestDeps } from '../ingest-prechunked';
import { ConflictError, UPLOAD_CHUNKED_MAX_PDF_BYTES, ValidationError } from '@app/domain';
import type { ParsedChunk } from '@app/domain';

function makeDeps(overrides?: Partial<PrechunkedIngestDeps>): PrechunkedIngestDeps {
  const insertMany = vi.fn().mockResolvedValue(undefined);
  const embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  const blobStorage = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    stream: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    documents: {
      findByName: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 1, fileName: 'doc.md', fileHash: 'hash-123', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
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
      countPendingIngest: vi.fn().mockResolvedValue(0),
      listStaleQueued: vi.fn().mockResolvedValue([]),
      failDocument: vi.fn().mockResolvedValue(undefined),
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
    pdfValidator: { validate: vi.fn().mockResolvedValue(undefined) },
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

  it('embeds header+content but stores clean content and title metadata when a summarizer is wired', async () => {
    const deps = makeDeps({
      summarizer: {
        generateDocContext: vi.fn().mockResolvedValue({ title: 'Manual', summary: 'Product manual.' }),
      },
    });
    const result = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith([
      'Document: Manual\nSummary: Product manual.\nSection: Getting Started\n\nGetting started body.',
      'Document: Manual\nSummary: Product manual.\nSection: Authentication\n\nAuth body.',
    ]);
    expect(deps.chunks.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ content: 'Getting started body.', title: 'Manual' }),
      expect.objectContaining({ content: 'Auth body.', title: 'Manual' }),
    ]);
  });

  it('passes the request abort signal to embedding', async () => {
    const signal = new AbortController().signal;
    const deps = makeDeps();

    const result = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', signal },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(
      ['Getting started body.', 'Auth body.'],
      { signal },
    );
  });

  it('stores the companion PDF blob only when provided', async () => {
    const deps = makeDeps();
    const pdf = Buffer.from('%PDF-1.4');
    await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
      deps,
    );
    expect(deps.blobStorage!.put).toHaveBeenCalledWith(
      expect.stringContaining('doc.pdf'),
      pdf,
      'application/pdf',
    );
    expect(deps.documents.setStorageKey).toHaveBeenCalledWith(1, expect.stringContaining('doc.pdf'));

    const depsNoPdf = makeDeps();
    await ingestPrechunked({ fileName: 'doc2.md', chunks: CHUNKS, uploadedBy: 'user' }, depsNoPdf);
    expect(depsNoPdf.blobStorage!.put).not.toHaveBeenCalled();
    expect(depsNoPdf.documents.setStorageKey).toHaveBeenCalledWith(1, null);
  });

  it('rejects an invalid companion PDF before embedding or durable storage', async () => {
    const deps = makeDeps({
      pdfValidator: { validate: vi.fn().mockRejectedValue(new Error('malformed PDF')) },
    });
    const result = await ingestPrechunked(
      {
        fileName: 'doc.md',
        chunks: CHUNKS,
        uploadedBy: 'user',
        pdfBuffer: Buffer.from('%PDF-garbage'),
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
    expect(deps.embeddings.embedBatch).not.toHaveBeenCalled();
    expect(deps.blobStorage?.put).not.toHaveBeenCalled();
  });

  it('rejects an oversized companion PDF before invoking the parser', async () => {
    const validate = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ pdfValidator: { validate } });
    const result = await ingestPrechunked(
      {
        fileName: 'doc.md',
        chunks: CHUNKS,
        uploadedBy: 'user',
        pdfBuffer: Buffer.alloc(UPLOAD_CHUNKED_MAX_PDF_BYTES + 1),
      },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(deps.embeddings.embedBatch).not.toHaveBeenCalled();
  });

  it('deletes the companion PDF blob when the transaction/writeChunks fails (M5)', async () => {
    const runner = {
      run: vi.fn().mockRejectedValue(new Error('tx failed')),
    } as unknown as NonNullable<PrechunkedIngestDeps['runner']>;
    const deps = makeDeps({ runner });
    const pdf = Buffer.from('%PDF-1.4');
    await expect(
      ingestPrechunked(
        { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
        deps,
      ),
    ).rejects.toThrow('tx failed');
    expect(deps.blobStorage!.put).toHaveBeenCalledWith(
      expect.stringContaining('doc.pdf'),
      pdf,
      'application/pdf',
    );
    expect(deps.blobStorage!.delete).toHaveBeenCalledWith(expect.stringContaining('doc.pdf'));
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
        countPendingIngest: vi.fn(),
        listStaleQueued: vi.fn().mockResolvedValue([]),
        failDocument: vi.fn().mockResolvedValue(undefined),
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

  it('rejects more than 5000 segments before embedding anything', async () => {
    const deps = makeDeps();
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ content: `chunk ${i}` }));
    const result = await ingestPrechunked({ fileName: 'huge.md', chunks: tooMany, uploadedBy: 'user' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/maximum is 5000/);
    expect(deps.embeddings.embedBatch).not.toHaveBeenCalled();
  });

  it('returns ExternalServiceError when embedding fails', async () => {
    const deps = makeDeps({
      embeddings: { embed: vi.fn(), embedBatch: vi.fn().mockRejectedValue(new Error('API down')) },
    });
    const result = await ingestPrechunked({ fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Embedding API failed/);
  });

  it('dedup hash covers the markdown even when a companion PDF is present (regression: PDF-only hash)', async () => {
    const makeHashing = () => ({ sha256: vi.fn((b: Buffer) => Buffer.from(b).toString('hex')) });
    const pdf = Buffer.from('%PDF-1.4-same-pdf');
    const canonicalHashInput = (chunks: ParsedChunk[], companionPdf: Buffer) => {
      const metadata = Buffer.from(JSON.stringify({
        schema: 'prechunked-file-v1',
        chunks: chunks.map((chunk) => ({
          content: chunk.content,
          page: chunk.page ?? null,
          sectionTitle: chunk.sectionTitle ?? null,
          source: chunk.source ?? null,
        })),
        companionPdfBytes: companionPdf.byteLength,
      }), 'utf8');
      return Buffer.concat([
        metadata,
        Buffer.from('\n--companion-pdf--\n', 'utf8'),
        companionPdf,
      ]).toString('hex');
    };

    const depsA = makeDeps({ hasher: makeHashing() });
    const resultAHash = canonicalHashInput(CHUNKS, pdf);
    depsA.documents.findByName = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({
      id: 1, fileName: 'doc.md', fileHash: resultAHash, uploadedBy: 'user',
      uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null,
    });
    const resultA = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
      depsA,
    );
    expect(resultA.ok).toBe(true);

    const CHUNKS_CHANGED: typeof CHUNKS = [{ content: 'Completely different body.', page: 1 }];
    const depsB = makeDeps({ hasher: makeHashing() });
    depsB.embeddings = { embed: vi.fn(), embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };
    const expectedHash = canonicalHashInput(CHUNKS_CHANGED, pdf);
    depsB.documents.findByName = vi.fn().mockResolvedValueOnce({
      id: 1, fileName: 'doc.md', fileHash: 'stored-hash-from-previous-upload', uploadedBy: 'user',
      uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null,
    }).mockResolvedValue({
      id: 1, fileName: 'doc.md', fileHash: expectedHash, uploadedBy: 'user',
      uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null,
    });
    const resultB = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS_CHANGED, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
      depsB,
    );
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultB.value.status).not.toBe('unchanged');
      expect(depsB.chunks.insertMany).toHaveBeenCalled();
    }
  });

  it('changes the dedup hash when chunk boundaries or provenance metadata change', async () => {
    const hashInputs: Buffer[] = [];
    let findCount = 0;
    const deps = makeDeps({
      documents: {
        ...makeDeps().documents,
        findByName: vi.fn().mockImplementation(async () => {
          findCount += 1;
          if (findCount === 1) return null;
          return {
            id: 1,
            fileName: 'doc.md',
            fileHash: `hash-${Math.max(1, Math.ceil((findCount - 1) / 2))}`,
            uploadedBy: 'user',
            uploadedAt: new Date(),
            storageKey: null,
            ingestStatus: 'done' as const,
            deletedAt: null,
          };
        }),
      },
      hasher: {
        sha256: vi.fn((value: Buffer) => {
          hashInputs.push(value);
          return `hash-${hashInputs.length}`;
        }),
      },
    });
    const first: ParsedChunk[] = [
      { content: 'left\n', page: 1, sectionTitle: 'Intro', source: 'manual.pdf' },
      { content: 'right', page: 2, sectionTitle: 'Details', source: 'manual.pdf' },
    ];
    const second: ParsedChunk[] = [
      { content: 'left', page: 1, sectionTitle: 'Intro', source: 'manual.pdf' },
      { content: '\nright', page: 99, sectionTitle: 'Details', source: 'manual.pdf' },
    ];

    const firstResult = await ingestPrechunked({ fileName: 'doc.md', chunks: first, uploadedBy: 'user' }, deps);
    const secondResult = await ingestPrechunked({ fileName: 'doc.md', chunks: second, uploadedBy: 'user' }, deps);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(hashInputs).toHaveLength(2);
    expect(hashInputs[0]).not.toEqual(hashInputs[1]);
    if (secondResult.ok) expect(secondResult.value.status).toBe('updated');
  });

  it('returns a conflict and deletes the blob when a concurrent writer wins the name', async () => {
    const pdf = Buffer.from('%PDF-1.4-conflict');
    const deps = makeDeps({
      documents: {
        ...makeDeps().documents,
        findByName: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 2, fileName: 'doc.md', fileHash: 'other-hash', uploadedBy: 'user', uploadedAt: new Date(), storageKey: null, ingestStatus: 'done' as const, deletedAt: null }),
      },
    });
    const result = await ingestPrechunked(
      { fileName: 'doc.md', chunks: CHUNKS, uploadedBy: 'user', pdfBuffer: pdf, pdfFileName: 'doc.pdf' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
    }
    expect(deps.blobStorage!.delete).toHaveBeenCalledWith(expect.stringContaining('doc.pdf'));
  });
});
