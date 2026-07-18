import { describe, it, expect, vi } from 'vitest';
import { reingestAll } from '../reingest';
import { ExternalServiceError } from '@app/domain';
import type { DocumentRepository, IngestQueue } from '@app/domain';

function makeDoc(id: number) {
  return {
    id,
    fileName: `doc-${id}.pdf`,
    fileHash: `h${id}`,
    uploadedBy: 'u',
    uploadedAt: new Date(),
    storageKey: `k${id}`,
    ingestStatus: 'done' as const,
    deletedAt: null,
    hasBlob: true,
  };
}

function listPage(ids: number[]) {
  return { documents: ids.map(makeDoc), total: ids.length };
}

describe('reingestAll', () => {
  it('enqueues every non-deleted document exactly once (single page)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const documents = {
      list: vi.fn().mockResolvedValue(listPage([1, 2, 3])),
    } as unknown as DocumentRepository;
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enqueued).toBe(3);
    expect(result.value.documentIds).toEqual([1, 2, 3]);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith({ documentId: 1 });
    expect(enqueue).toHaveBeenCalledWith({ documentId: 2 });
    expect(enqueue).toHaveBeenCalledWith({ documentId: 3 });
  });

  it('paginates across multiple pages using the repository total', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const documents = {
      list: vi.fn(async () => {
        call++;
        if (call === 1) return { documents: [makeDoc(1), makeDoc(2)], total: 5 };
        if (call === 2) return { documents: [makeDoc(3), makeDoc(4)], total: 5 };
        return { documents: [makeDoc(5)], total: 5 };
      }),
    } as unknown as DocumentRepository;
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enqueued).toBe(5);
    expect(result.value.documentIds).toEqual([1, 2, 3, 4, 5]);
    expect(enqueue).toHaveBeenCalledTimes(5);
  });

  it('returns zero enqueued when there are no documents', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const documents = {
      list: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
    } as unknown as DocumentRepository;
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enqueued).toBe(0);
    expect(result.value.documentIds).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('only lists non-deleted documents', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue(listPage([9]));
    const documents = { list } as unknown as DocumentRepository;
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    await reingestAll({ documents, queue });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ includeDeleted: false }),
    );
  });

  it('refuses to re-ingest when the queue is a no-op (no worker wired)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue(listPage([1, 2, 3]));
    const documents = { list } as unknown as DocumentRepository;
    const queue = { enqueue, isNoOp: () => true } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExternalServiceError);
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
