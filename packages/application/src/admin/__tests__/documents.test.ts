import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundError, ValidationError, GoneError } from '@app/domain';
import type { DocumentRepository, AuditLog, Clock, TransactionRunner, TransactionContext } from '@app/domain';
import { restoreDocument, softDeleteDocument, hardDeleteDocument, uploadPdf, replacePdf } from '../documents';
import { RESTORE_WINDOW_MS } from '@app/domain';

function makeMockDeps(overrides: {
  documents?: Partial<DocumentRepository>;
  audit?: Partial<AuditLog>;
  clock?: Partial<Clock>;
  runner?: Partial<TransactionRunner>;
  blobStorage?: { delete?: (key: string) => Promise<void> };
} = {}) {
  const documents = {
    findById: vi.fn().mockResolvedValue(null),
    softDelete: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
    findByName: vi.fn().mockResolvedValue(null),
    setStorageKey: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue({} as never),
    deleteById: vi.fn().mockResolvedValue(undefined),
    countChunksForDocuments: vi.fn().mockResolvedValue(new Map()),
    countChunksForAll: vi.fn().mockResolvedValue(0),
    ...overrides.documents,
  } as DocumentRepository;
  const audit = {
    logDocumentEvent: vi.fn().mockResolvedValue(undefined),
    logTicketEvent: vi.fn().mockResolvedValue(undefined),
    logUserEvent: vi.fn().mockResolvedValue(undefined),
    recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    ...overrides.audit,
  } as AuditLog;
  const clock = {
    now: vi.fn(() => new Date()),
    ...overrides.clock,
  } as Clock;
  const runner = {
    run: vi.fn(async (fn: (ctx: TransactionContext) => Promise<unknown>) => {
      return fn({ documents, audit, chunks: {} as never, tickets: {} as never, users: {} as never });
    }),
    ...overrides.runner,
  } as TransactionRunner;
  const blobStorage = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('')),
    stream: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides.blobStorage,
  } as unknown as import('@app/domain').BlobStorage & { delete: ReturnType<typeof vi.fn> };
  const users = {
    findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' }),
  } as unknown as import('@app/domain').UserRepository;
  return { documents, audit, clock, runner, blobStorage, users };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('restoreDocument', () => {
  it('returns NotFoundError for missing document', async () => {
    const deps = makeMockDeps();
    const result = await restoreDocument(999, 'user_1', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('returns ValidationError for non-deleted document', async () => {
    const deps = makeMockDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          id: 1,
          deletedAt: null,
        }),
      },
    });
    const result = await restoreDocument(1, 'user_1', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it('returns GoneError when restore window expired', async () => {
    const deletedAt = new Date(Date.now() - RESTORE_WINDOW_MS - 1000);
    const deps = makeMockDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          id: 1,
          deletedAt,
        }),
      },
      clock: {
        now: vi.fn(() => new Date()),
      },
    });
    const result = await restoreDocument(1, 'user_1', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GoneError);
    }
  });

  it('restores within window', async () => {
    const deletedAt = new Date(Date.now() - 1000);
    const deps = makeMockDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          id: 1,
          deletedAt,
        }),
      },
      clock: {
        now: vi.fn(() => new Date()),
      },
    });
    const result = await restoreDocument(1, 'user_1', deps);
    expect(result.ok).toBe(true);
    expect(deps.documents.restore).toHaveBeenCalledWith(1);
    expect(deps.documents.findById).toHaveBeenCalledWith(1, { includeDeleted: true });
  });
});

describe('hardDeleteDocument', () => {
  it('returns NotFoundError for missing document', async () => {
    const deps = makeMockDeps();
    const result = await hardDeleteDocument({ documentId: 999, actorId: 'user_1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundError);
  });

  it('hard-deletes an already soft-deleted document', async () => {
    const deps = makeMockDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({ id: 1, deletedAt: new Date(), storageKey: 'docs/x/f.pdf' }),
      },
    });
    const result = await hardDeleteDocument({ documentId: 1, actorId: 'user_1' }, deps);
    expect(result.ok).toBe(true);
    expect(deps.documents.findById).toHaveBeenCalledWith(1, { includeDeleted: true });
    expect(deps.documents.deleteById).toHaveBeenCalledWith(1);
    expect(deps.audit.logDocumentEvent).toHaveBeenCalledWith({
      action: 'delete',
      documentId: 1,
      actorId: 'user_1',
    });
    expect(deps.blobStorage.delete).toHaveBeenCalledWith('docs/x/f.pdf');
  });
});

describe('softDeleteDocument', () => {
  it('returns NotFoundError for missing document', async () => {
    const deps = makeMockDeps();
    const result = await softDeleteDocument({ documentId: 999, actorId: 'user_1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('soft-deletes existing document', async () => {
    const deps = makeMockDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({ id: 1, deletedAt: null }),
      },
    });
    const result = await softDeleteDocument({ documentId: 1, actorId: 'user_1' }, deps);
    expect(result.ok).toBe(true);
    expect(deps.documents.softDelete).toHaveBeenCalledOnce();
    expect(deps.audit.logDocumentEvent).toHaveBeenCalledWith({
      action: 'delete',
      documentId: 1,
      actorId: 'user_1',
    });
  });
});

const ASYNC_MIN = 4 * 1024 * 1024 + 1;

function baseDocument(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    fileName: 'f.pdf',
    fileHash: 'newhash',
    uploadedBy: 'user_1',
    uploadedAt: new Date(),
    storageKey: null,
    ingestStatus: 'queued',
    deletedAt: null,
    ...overrides,
  };
}

function makeUploadDeps(opts: {
  documents?: Partial<Record<string, unknown>>;
  rejectEnqueue?: boolean;
  runnerError?: boolean;
} = {}): {
  deps: Parameters<typeof uploadPdf>[1];
  documents: DocumentRepository;
  blobStorage: { delete: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  ingestQueue: { enqueue: ReturnType<typeof vi.fn> };
  runner: { run: ReturnType<typeof vi.fn> };
  audit: { logDocumentEvent: ReturnType<typeof vi.fn> };
  chunks: { insertMany: ReturnType<typeof vi.fn>; deleteByDocumentId: ReturnType<typeof vi.fn> };
} {
  const documents = {
    findByName: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(baseDocument({ id: 1, fileHash: 'newhash', ingestStatus: 'queued' })),
    insert: vi.fn().mockResolvedValue(baseDocument()),
    setStorageKey: vi.fn().mockResolvedValue(undefined),
    updateIngestStatus: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(baseDocument()),
    deleteById: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn(),
    list: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
    countChunksForDocuments: vi.fn().mockResolvedValue(new Map()),
    countChunksForAll: vi.fn().mockResolvedValue(0),
    ...opts.documents,
  } as unknown as DocumentRepository;
  const chunks = {
    insertMany: vi.fn().mockResolvedValue(undefined),
    deleteByDocumentId: vi.fn().mockResolvedValue(undefined),
    countForDocuments: vi.fn(),
    countForAll: vi.fn(),
  };
  const audit = { logDocumentEvent: vi.fn().mockResolvedValue(undefined) };
  const blobStorage = {
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const ingestQueue = {
    enqueue: opts.rejectEnqueue
      ? vi.fn().mockRejectedValue(new Error('qstash down'))
      : vi.fn().mockResolvedValue(undefined),
  };
  const runner = {
    run: opts.runnerError
      ? vi.fn().mockRejectedValue(new Error('tx failed'))
      : vi.fn(async (fn: (ctx: TransactionContext) => Promise<unknown>) =>
          fn({ documents: documents as never, chunks: chunks as never, audit: audit as never, tickets: {} as never, users: {} as never }),
        ),
  };
  const users = { findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' }) };
  const deps = {
    documents,
    chunks: chunks as never,
    embeddings: { embed: vi.fn(), embedBatch: vi.fn().mockResolvedValue([[0.1]]) },
    hasher: { sha256: vi.fn().mockReturnValue('newhash') },
    pdfParser: { extractText: vi.fn().mockResolvedValue('body') },
    textSplitter: { splitText: vi.fn().mockResolvedValue(['body']) },
    runner,
    audit,
    blobStorage,
    ingestQueue,
    users,
  };
  return { deps: deps as unknown as Parameters<typeof uploadPdf>[1], documents, blobStorage, ingestQueue, runner, audit, chunks };
}

describe('uploadPdf / replacePdf (ingest lifecycle)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resurrects a soft-deleted doc that is re-uploaded unchanged within the restore window', async () => {
    const mocks = makeUploadDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'newhash', storageKey: 'old-blob', deletedAt: new Date(Date.now() - 1000) }),
        }),
      },
    });
    const result = await uploadPdf({ fileName: 'f.pdf', buffer: Buffer.from('small'), actorId: 'user_1' }, mocks.deps);
    expect(result.ok).toBe(true);
    expect(mocks.documents.restore).toHaveBeenCalledWith(1);
    expect(mocks.audit.logDocumentEvent).toHaveBeenCalledWith({ action: 'restore', documentId: 1, actorId: 'user_1' });
    if (result.ok) expect(result.value.status).toBe('unchanged');
  });

  it('logs a restore audit event when the async path re-uploads a soft-deleted doc unchanged (M3)', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'newhash', storageKey: 'old-blob', deletedAt: new Date(Date.now() - 1000) }),
        }),
      },
    });
    const result = await uploadPdf(
      { fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(true);
    expect(mocks.documents.restore).toHaveBeenCalledWith(1);
    expect(mocks.audit.logDocumentEvent).toHaveBeenCalledWith({ action: 'restore', documentId: 1, actorId: 'user_1' });
    if (result.ok) expect(result.value.status).toBe('unchanged');
  });

  it('does not dedup against a soft-deleted doc beyond the restore window and cleans its blob', async () => {
    const oldKey = 'old-orphan.pdf';
    const mocks = makeUploadDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'oldhash', storageKey: oldKey, deletedAt: new Date(Date.now() - RESTORE_WINDOW_MS - 1000) }),
        }),
      },
    });
    const result = await uploadPdf({ fileName: 'f.pdf', buffer: Buffer.from('small'), actorId: 'user_1' }, mocks.deps);
    expect(result.ok).toBe(true);
    expect(mocks.blobStorage.delete).toHaveBeenCalledWith(oldKey);
  });

  it('cleans up the freshly-uploaded blob when the transaction fails (no orphan)', async () => {
    const mocks = makeUploadDeps({ runnerError: true });
    const result = await uploadPdf({ fileName: 'f.pdf', buffer: Buffer.from('small'), actorId: 'user_1' }, mocks.deps);
    expect(result.ok).toBe(false);
    expect(mocks.blobStorage.put).toHaveBeenCalledTimes(1);
    expect(mocks.blobStorage.delete).toHaveBeenCalledTimes(1);
  });

  it('enqueues large uploads asynchronously and marks the row queued', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps();
    const result = await uploadPdf(
      { fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('queued');
      expect(result.value.documentId).toBe(7);
    }
    expect(mocks.documents.insert).toHaveBeenCalled();
    expect(mocks.ingestQueue.enqueue).toHaveBeenCalledWith({ documentId: 7 });
    expect(mocks.documents.updateIngestStatus).toHaveBeenCalledWith(7, 'queued');
  });

  it('rolls back a brand-new async upload when enqueue fails so a retry can re-upload', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps({ rejectEnqueue: true });
    const result = await uploadPdf(
      { fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(false);
    expect(mocks.documents.deleteById).toHaveBeenCalledWith(7);
    expect(mocks.blobStorage.delete).toHaveBeenCalled();
  });

  it('reverts fileHash, status, and storageKey on replace-enqueue failure so re-upload is not falsely unchanged', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'old-hash', storageKey: 'docs/old/f.pdf', ingestStatus: 'done' }),
        }),
      },
      rejectEnqueue: true,
    });
    const result = await replacePdf(
      { documentId: 1, fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(false);
    expect(mocks.documents.update).toHaveBeenLastCalledWith(1, {
      fileHash: 'old-hash',
      ingestStatus: 'done',
      storageKey: 'docs/old/f.pdf',
    });
  });

  it('cleans up the new blob and keeps the old one when enqueue fails on a reused row (M4)', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps({
      documents: {
        findByName: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'old-hash', storageKey: 'docs/old/f.pdf', ingestStatus: 'done' }),
        }),
      },
      rejectEnqueue: true,
    });
    const result = await uploadPdf(
      { fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(false);
    expect(mocks.blobStorage.delete).not.toHaveBeenCalledWith('docs/old/f.pdf');
    expect(mocks.blobStorage.delete).toHaveBeenCalledTimes(1);
    // The reused row must point back at the old blob, not the deleted new key.
    expect(mocks.documents.update).toHaveBeenLastCalledWith(1, {
      fileHash: 'old-hash',
      ingestStatus: 'done',
      storageKey: 'docs/old/f.pdf',
    });
  });

  it('deletes the newly-uploaded blob when parseAndEmbed fails on replace (M1)', async () => {
    const mocks = makeUploadDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'old-hash', storageKey: 'docs/old/f.pdf', ingestStatus: 'done' }),
        }),
      },
    });
    mocks.deps.pdfParser.extractText = vi.fn().mockRejectedValue(new Error('corrupt pdf'));
    const result = await replacePdf(
      { documentId: 1, fileName: 'f.pdf', buffer: Buffer.from('small'), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(false);
    expect(mocks.blobStorage.put).toHaveBeenCalledTimes(1);
    expect(mocks.blobStorage.delete).toHaveBeenCalledTimes(1);
    expect(mocks.documents.update).not.toHaveBeenCalled();
  });

  it('does not delete chunks on the async replace path (worker-side delete owns it)', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'x');
    const mocks = makeUploadDeps({
      documents: {
        findById: vi.fn().mockResolvedValue({
          ...baseDocument({ id: 1, fileHash: 'old', storageKey: 'docs/old/f.pdf', ingestStatus: 'done' }),
        }),
      },
    });
    const result = await replacePdf(
      { documentId: 1, fileName: 'f.pdf', buffer: Buffer.alloc(ASYNC_MIN), actorId: 'user_1' },
      mocks.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('queued');
      expect(result.value.chunks).toBe(0);
    }
    expect(mocks.ingestQueue.enqueue).toHaveBeenCalledWith({ documentId: 1 });
    expect(mocks.chunks.deleteByDocumentId).not.toHaveBeenCalled();
  });
});
