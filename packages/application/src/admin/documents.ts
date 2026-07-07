// Admin document use-cases: list, upload, replace, soft-delete,
// restore, hard-delete, recount.
import {
  err,
  ok,
  type Result,
  NotFoundError,
  ConflictError,
  ValidationError,
  GoneError,
  ExternalServiceError,
} from '@app/domain';
import type {
  DocumentRepository,
  ChunkRepository,
  AuditLog,
  Clock,
  UserRepository,
  TransactionRunner,
  BlobStorage,
  IngestQueue,
  IngestStatus,
} from '@app/domain';
import { ingestFile } from '../rag/ingest';
import type { IngestDeps, IngestResult } from '../rag/ingest';
import { RESTORE_WINDOW_MS, MAX_LIST_LIMIT } from '../../../../config/constants';
import { wrapServiceCall, serviceResult, sanitizePagination } from '../service-result';

/** Build the object-storage key for a document's PDF binary. The key
 *  is namespaced under `docs/` and prefixed by the document id so that
 *  renaming a file (or two different docs sharing a sanitized name)
 *  can never collide. */
function blobKey(documentId: number, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `docs/${documentId}/${safe}`;
}

async function ensureDocument(
  documentId: number,
  dep: DocumentRepository,
): Promise<Result<{ documentId: number }>> {
  const existing = await dep.findById(documentId);
  if (!existing) return err(new NotFoundError(`Document not found: ${documentId}`));
  return ok({ documentId });
}

interface ListDocumentsInput {
  search?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export async function listDocuments(
  input: ListDocumentsInput,
  deps: {
    documents: DocumentRepository;
    chunks: ChunkRepository;
    users: UserRepository;
  },
): Promise<
  Result<{
    documents: Array<{
      id: number;
      fileName: string;
      fileHash: string;
      uploadedBy: string;
      uploadedAt: Date;
      storageKey: string | null;
      ingestStatus: IngestStatus;
      deletedAt: Date | null;
      uploaderName: string | null;
      chunkCount: number;
      hasBlob: boolean;
    }>;
    total: number;
  }>
> {
  return wrapServiceCall(async () => {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const { documents, total } = await deps.documents.list({
      search: input.search,
      includeDeleted: input.includeDeleted,
      limit,
      offset,
    });
    const ids = documents.map((d) => d.id);
    const chunkCounts =
      ids.length > 0
        ? await deps.chunks.countForDocuments(ids)
        : new Map<number, number>();
    const uploaderIds = [...new Set(documents.map((d) => d.uploadedBy))];
    const uploaders =
      uploaderIds.length > 0 ? await deps.users.findByIds(uploaderIds) : [];
    const uploaderMap = new Map<string, string | null>();
    for (const u of uploaders) {
      uploaderMap.set(u.clerkUserId, u.name ?? null);
    }
    const result = documents.map((d) => ({
      ...d,
      hasBlob: Boolean(d.hasBlob),
      uploaderName: uploaderMap.get(d.uploadedBy) ?? null,
      chunkCount: chunkCounts.get(d.id) ?? 0,
    }));
    return ok({ documents: result, total });
  }, 'Failed to list documents');
}

/** Files at or above this size go through the async QStash ingest path
 *  (when `QSTASH_TOKEN` is set). Smaller files ingest synchronously.
 *  4 MB matches Vercel's server-action request body limit. */
const ASYNC_INGEST_THRESHOLD = 4 * 1024 * 1024;

/** Whether the async ingest path is enabled: only when a QStash token
 *  is configured. Without it, the queue is a no-op and every upload
 *  ingests synchronously regardless of size. */
function asyncIngestEnabled(): boolean {
  return Boolean(process.env.QSTASH_TOKEN);
}

export async function uploadPdf(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
): Promise<Result<IngestResult>> {
  return wrapServiceCall(async () => {
    if (input.buffer.length >= ASYNC_INGEST_THRESHOLD && asyncIngestEnabled()) {
      return queuePdfForIngest(input, deps, (newId) => ({ action: 'upload', documentId: newId }));
    }
    return uploadPdfSync(input, deps);
  }, 'Failed to upload PDF');
}

/** Synchronous ingest: parse, embed, insert chunks, put blob, set
 *  storage key — all in a transaction. Used for small PDFs (<4 MB)
 *  or always when `QSTASH_TOKEN` is unset. Sets `ingest_status='done'`
 *  (the column default, applied at insert). */
async function uploadPdfSync(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage },
): Promise<Result<IngestResult>> {
  return await deps.runner.run(async (tx) => {
    const r = await ingestFile(
      { fileName: input.fileName, buffer: input.buffer, uploadedBy: input.actorId },
      { ...deps, documents: tx.documents, chunks: tx.chunks },
    );
    if (!r.ok) return r;
    const key = blobKey(r.value.documentId, input.fileName);
    await deps.blobStorage.put(key, input.buffer, 'application/pdf');
    await tx.documents.setStorageKey(r.value.documentId, key);
    await tx.audit.logDocumentEvent({
      action: r.value.status === 'inserted' ? 'upload' : 'replace',
      documentId: r.value.documentId,
      actorId: input.actorId,
    });
    return r;
  });
}

/** Asynchronous ingest core: store the blob, insert a `documents` row
 *  with `ingest_status='queued'`, and enqueue a QStash message. No
 *  parsing/embedding happens here — the worker does that on callback.
 *  Handles name dedup the same way `ingestFile` does (same hash →
 *  unchanged; different hash → delete the old row and its blob first)
 *  because `documents.file_name` is unique. `auditFor` receives the
 *  new row's id so the caller can choose the audit action/documentId
 *  (upload logs the new id; replace logs the original documentId). */
async function queuePdfForIngest(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
  auditFor: (newDocumentId: number) => { action: 'upload' | 'replace'; documentId: number },
): Promise<Result<IngestResult>> {
  const fileHash = deps.hasher.sha256(input.buffer);
  const existing = await deps.documents.findByName(input.fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }
  if (existing && existing.storageKey) {
    await deps.blobStorage.delete(existing.storageKey).catch(() => {
      // Best-effort: an orphaned blob is preferable to blocking the
      // re-upload. The old row is deleted below regardless.
    });
  }
  const inserted = await deps.runner.run(async (tx) => {
    if (existing && existing.fileHash !== fileHash) {
      await tx.documents.deleteById(existing.id);
    }
    const row = await tx.documents.insert({
      fileName: input.fileName,
      fileHash,
      uploadedBy: input.actorId,
    });
    const key = blobKey(row.id, input.fileName);
    await deps.blobStorage.put(key, input.buffer, 'application/pdf');
    await tx.documents.setStorageKey(row.id, key);
    await tx.documents.updateIngestStatus(row.id, 'queued');
    const a = auditFor(row.id);
    await tx.audit.logDocumentEvent({
      action: a.action,
      documentId: a.documentId,
      actorId: input.actorId,
    });
    return row;
  });
  try {
    await deps.ingestQueue.enqueue({ documentId: inserted.id });
  } catch (e) {
    // The blob + row are committed but the QStash publish failed.
    // Mark `failed` so the UI doesn't show a forever-`queued` doc.
    // A future re-drive can re-enqueue once QStash is reachable.
    await deps.documents.updateIngestStatus(inserted.id, 'failed').catch(() => {});
    throw e;
  }
  return ok({ documentId: inserted.id, chunks: 0, status: 'queued' });
}

export async function softDeleteDocument(
  input: { documentId: number; actorId: string },
  deps: { documents: DocumentRepository; audit: AuditLog; runner: TransactionRunner },
): Promise<Result<void>> {
  return wrapServiceCall(async () => {
    const check = await ensureDocument(input.documentId, deps.documents);
    if (!check.ok) return check;
    await deps.runner.run(async (tx) => {
      await tx.documents.softDelete(input.documentId, new Date());
      await tx.audit.logDocumentEvent({
        action: 'delete',
        documentId: input.documentId,
        actorId: input.actorId,
      });
    });
    return ok(undefined);
  }, 'Failed to soft-delete document');
}

export async function restoreDocument(
  documentId: number,
  actorId: string,
  deps: { documents: DocumentRepository; audit: AuditLog; clock: Clock; runner: TransactionRunner },
): Promise<Result<void>> {
  try {
    const doc = await deps.documents.findById(documentId);
    if (!doc) return err(new NotFoundError('Document not found'));
    if (!doc.deletedAt) return err(new ValidationError('Document is not deleted'));
    if (deps.clock.now().getTime() - doc.deletedAt.getTime() > RESTORE_WINDOW_MS) {
      return err(new GoneError('Restore window expired'));
    }
    await deps.runner.run(async (tx) => {
      await tx.documents.restore(documentId);
      await tx.audit.logDocumentEvent({ action: 'restore', documentId, actorId });
    });
    return ok(undefined);
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ValidationError || e instanceof GoneError) {
      return err(e);
    }
    return err(new ConflictError('Document restore transaction failed'));
  }
}

export async function getDocumentById(
  documentId: number,
  deps: { documents: DocumentRepository },
): Promise<Result<{ document: import('@app/domain').DocumentRow | null }>> {
  return serviceResult(
    () => deps.documents.findById(documentId).then((doc) => ({ document: doc })),
    'Failed to get document',
  );
}

export async function hardDeleteDocument(
  input: { documentId: number; actorId: string },
  deps: { documents: DocumentRepository; audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage },
): Promise<Result<void>> {
  return wrapServiceCall(async () => {
    const existing = await deps.documents.findById(input.documentId);
    if (!existing) return err(new NotFoundError(`Document not found: ${input.documentId}`));
    // Clean up the stored blob before the DB row disappears — once the
    // row is gone we no longer know which key to delete.
    const storageKey = existing.storageKey;
    await deps.runner.run(async (tx) => {
      await tx.audit.logDocumentEvent({
        action: 'delete',
        documentId: input.documentId,
        actorId: input.actorId,
      });
      await tx.documents.deleteById(input.documentId);
    });
    if (storageKey) {
      await deps.blobStorage.delete(storageKey).catch(() => {
        // Best-effort: an orphaned blob is preferable to failing the
        // hard-delete. Logged by the caller if needed.
      });
    }
    return ok(undefined);
  }, 'Failed to hard-delete document');
}

export async function replacePdf(
  input: { documentId: number; fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
): Promise<Result<IngestResult>> {
  return wrapServiceCall(async () => {
    const check = await ensureDocument(input.documentId, deps.documents);
    if (!check.ok) return check;

    if (input.buffer.length >= ASYNC_INGEST_THRESHOLD && asyncIngestEnabled()) {
      // Replace via the async queue: audit `replace` against the
      // original documentId (mirrors the sync path's convention).
      return queuePdfForIngest(
        input,
        deps,
        () => ({ action: 'replace', documentId: input.documentId }),
      );
    }

    return await deps.runner.run(async (tx) => {
      const r = await ingestFile(
        { fileName: input.fileName, buffer: input.buffer, uploadedBy: input.actorId },
        { ...deps, documents: tx.documents, chunks: tx.chunks },
      );
      if (!r.ok) return r;
      const key = blobKey(r.value.documentId, input.fileName);
      await deps.blobStorage.put(key, input.buffer, 'application/pdf');
      await tx.documents.setStorageKey(r.value.documentId, key);
      if (r.value.status !== 'unchanged') {
        await tx.audit.logDocumentEvent({
          action: 'replace',
          documentId: input.documentId,
          actorId: input.actorId,
        });
      }
      return r;
    });
  }, 'Failed to replace PDF');
}

export async function recountChunksForDocument(
  documentId: number,
  deps: { chunks: ChunkRepository },
): Promise<Result<{ documentId: number; count: number }>> {
  return serviceResult(
    () => deps.chunks.countForDocument(documentId).then((count) => ({ documentId, count })),
    'Failed to recount chunks',
  );
}

export async function recountChunksForAllDocuments(
  deps: { chunks: ChunkRepository },
): Promise<Result<Array<{ documentId: number; count: number }>>> {
  return serviceResult(() => deps.chunks.recountAll(), 'Failed to recount chunks for all documents');
}
