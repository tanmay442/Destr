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

function makeDocsRepo(list: ReturnType<typeof vi.fn>) {
  return {
    list,
    update: vi.fn().mockResolvedValue(makeDoc(1)),
  } as unknown as DocumentRepository;
}

describe('reingestAll', () => {
  it('enqueues every non-deleted document exactly once (single page)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const documents = makeDocsRepo(vi.fn().mockResolvedValue(listPage([1, 2, 3])));
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enqueued).toBe(3);
    expect(result.value.documentIds).toEqual([1, 2, 3]);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ documentId: 1, fileHash: 'h1', attemptId: expect.any(String) }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ documentId: 2, fileHash: 'h2', attemptId: expect.any(String) }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ documentId: 3, fileHash: 'h3', attemptId: expect.any(String) }));
  });

  it('paginates across multiple pages using the repository total', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const documents = makeDocsRepo(
      vi.fn(async () => {
        call++;
        if (call === 1) return { documents: [makeDoc(1), makeDoc(2)], total: 5 };
        if (call === 2) return { documents: [makeDoc(3), makeDoc(4)], total: 5 };
        return { documents: [makeDoc(5)], total: 5 };
      }),
    );
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
    const documents = makeDocsRepo(vi.fn().mockResolvedValue({ documents: [], total: 0 }));
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
    const documents = makeDocsRepo(list);
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    await reingestAll({ documents, queue });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ includeDeleted: false }),
    );
  });

  it('resets a `done` document to `queued` before enqueueing (regression: was a silent no-op)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const documents = makeDocsRepo(vi.fn().mockResolvedValue(listPage([1])));
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    expect(documents.update).toHaveBeenCalledWith(1, { ingestStatus: 'queued' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ documentId: 1, fileHash: 'h1', attemptId: expect.any(String) }));
  });

  it('does not re-reset an already-queued document', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue({
      documents: [{ ...makeDoc(1), ingestStatus: 'queued' as const }],
      total: 1,
    });
    const documents = makeDocsRepo(list);
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(true);
    expect(documents.update).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ documentId: 1, fileHash: 'h1', attemptId: expect.any(String) }));
  });

  it('leaves existing chunks for the worker to replace atomically', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const documents = makeDocsRepo(vi.fn().mockResolvedValue(listPage([1, 2])));
    const chunks = { deleteByDocumentId: vi.fn().mockResolvedValue(undefined) };
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue, chunks } as never);
    expect(result.ok).toBe(true);
    expect(chunks.deleteByDocumentId).not.toHaveBeenCalled();
  });

  it('refuses to re-ingest when the queue is a no-op (no worker wired)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue(listPage([1, 2, 3]));
    const documents = makeDocsRepo(list);
    const queue = { enqueue, isNoOp: () => true } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExternalServiceError);
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('restores a document status when enqueue fails, leaving earlier docs queued', async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('qstash down'));
    const documents = makeDocsRepo(vi.fn().mockResolvedValue(listPage([1, 2])));
    const queue = { enqueue, isNoOp: () => false } as unknown as IngestQueue;

    const result = await reingestAll({ documents, queue });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExternalServiceError);
      expect(result.error.message).toContain('Failed to enqueue document 2');
    }
    expect(documents.update).toHaveBeenCalledWith(1, { ingestStatus: 'queued' });
    expect(documents.update).toHaveBeenCalledWith(2, { ingestStatus: 'queued' });
    expect(documents.update).toHaveBeenCalledWith(2, { ingestStatus: 'done' });
    expect(documents.update).not.toHaveBeenCalledWith(1, { ingestStatus: 'done' });
  });
});
