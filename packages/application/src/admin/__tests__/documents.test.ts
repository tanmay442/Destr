import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ValidationError, GoneError } from '@app/domain';
import type { DocumentRepository, AuditLog, Clock, TransactionRunner, TransactionContext } from '@app/domain';
import { restoreDocument, softDeleteDocument, hardDeleteDocument } from '../documents';
import { RESTORE_WINDOW_MS } from '../../../../../config/constants';

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
  return { documents, audit, clock, runner, blobStorage };
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
    // Regression: a soft-deleted doc must be looked up including deleted rows.
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
    // Regression: must resolve soft-deleted rows, then cascade-delete + drop blob.
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
