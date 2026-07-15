import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  NotFoundError,
  ConflictError,
  ValidationError,
  GoneError,
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
import { ingestFile, parseAndEmbed } from '../rag/ingest';
import type { IngestDeps, IngestResult } from '../rag/ingest';
import { RESTORE_WINDOW_MS, MAX_LIST_LIMIT } from '../../../../config/constants';
import { wrapServiceCall, serviceResult, sanitizePagination } from '../service-result';

/** Object-storage key, unique per upload so renames/duplicates never collide. */
function newBlobKey(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `docs/${randomUUID()}/${safe}`;
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

/** ≥4 MB uses the async QStash path (when QSTASH_TOKEN is set); matches Vercel's body limit. */
const ASYNC_INGEST_THRESHOLD = 4 * 1024 * 1024;

/** Async ingest only when QSTASH_TOKEN is set; else every upload is synchronous. */
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

async function uploadPdfSync(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage },
): Promise<Result<IngestResult>> {
  const fileHash = deps.hasher.sha256(input.buffer);
  const existing = await deps.documents.findByName(input.fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }
  const oldStorageKey = existing?.storageKey ?? null;
  // Upload the blob BEFORE the DB transaction so a tx rollback can never
  // leave the row pointing at a deleted blob.
  const key = newBlobKey(input.fileName);
  await deps.blobStorage.put(key, input.buffer, 'application/pdf');
  const r = await deps.runner.run(async (tx) => {
    const res = await ingestFile(
      { fileName: input.fileName, buffer: input.buffer, uploadedBy: input.actorId },
      { ...deps, documents: tx.documents, chunks: tx.chunks },
    );
    if (!res.ok) return res;
    await tx.documents.setStorageKey(res.value.documentId, key);
    await tx.audit.logDocumentEvent({
      action: res.value.status === 'inserted' ? 'upload' : 'replace',
      documentId: res.value.documentId,
      actorId: input.actorId,
    });
    return res;
  });
  // Only delete the superseded blob after the new row has committed.
  if (r.ok && oldStorageKey) {
    await deps.blobStorage.delete(oldStorageKey).catch(() => {
      // Orphaned blob beats failing the upload.
    });
  }
  return r;
}

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
  const oldStorageKey = existing?.storageKey ?? null;
  // Upload the blob BEFORE the DB transaction so a tx rollback can never
  // leave the row pointing at a deleted blob.
  const key = newBlobKey(input.fileName);
  await deps.blobStorage.put(key, input.buffer, 'application/pdf');
  const inserted = await deps.runner.run(async (tx) => {
    if (existing && existing.fileHash !== fileHash) {
      await tx.documents.deleteById(existing.id);
    }
    const row = await tx.documents.insert({
      fileName: input.fileName,
      fileHash,
      uploadedBy: input.actorId,
    });
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
  // Only delete the superseded blob after the new row has committed.
  if (oldStorageKey) {
    await deps.blobStorage.delete(oldStorageKey).catch(() => {
      // Orphaned blob beats blocking the re-upload.
    });
  }
  try {
    await deps.ingestQueue.enqueue({ documentId: inserted.id });
  } catch (e) {
    // Commit done but QStash publish failed; mark `failed` so UI never shows forever-`queued`.
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
    const doc = await deps.documents.findById(documentId, { includeDeleted: true });
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
  opts: { includeDeleted?: boolean } = {},
): Promise<Result<{ document: import('@app/domain').DocumentRow | null }>> {
  return serviceResult(
    () => deps.documents.findById(documentId, opts).then((doc) => ({ document: doc })),
    'Failed to get document',
  );
}

export async function hardDeleteDocument(
  input: { documentId: number; actorId: string },
  deps: { documents: DocumentRepository; audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage },
): Promise<Result<void>> {
  return wrapServiceCall(async () => {
    const existing = await deps.documents.findById(input.documentId, { includeDeleted: true });
    if (!existing) return err(new NotFoundError(`Document not found: ${input.documentId}`));
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
        // Orphaned blob beats failing the hard-delete.
      });
    }
    return ok(undefined);
  }, 'Failed to hard-delete document');
}

export async function replacePdf(
  input: { documentId: number; fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
): Promise<Result<IngestResult>> {
  return wrapServiceCall(async (): Promise<Result<IngestResult>> => {
    const existing = await deps.documents.findById(input.documentId);
    if (!existing) return err(new NotFoundError(`Document not found: ${input.documentId}`));

    const fileHash = deps.hasher.sha256(input.buffer);
    if (existing.fileHash === fileHash) {
      return ok({ documentId: input.documentId, chunks: 0, status: 'unchanged' });
    }

    // Resolve by documentId (never by fileName) so we never touch an unrelated
    // document, and audit against the id that actually survives the replace.
    const oldStorageKey = existing.storageKey;
    const key = newBlobKey(input.fileName);
    // Upload the new blob BEFORE the transaction; the old blob is removed only
    // after the new row commits.
    await deps.blobStorage.put(key, input.buffer, 'application/pdf');

    const useAsync = input.buffer.length >= ASYNC_INGEST_THRESHOLD && asyncIngestEnabled();
    let parsed: Awaited<ReturnType<typeof parseAndEmbed>> | null = null;
    if (!useAsync) {
      parsed = await parseAndEmbed(
        { fileName: input.fileName, buffer: input.buffer },
        deps,
      );
      if (!parsed.ok) return parsed;
    }

    const newId = await deps.runner.run(async (tx) => {
      await tx.documents.deleteById(input.documentId);
      const row = await tx.documents.insert({
        fileName: input.fileName,
        fileHash,
        uploadedBy: input.actorId,
      });
      if (parsed) {
        await tx.chunks.insertMany(
          parsed.value.rows.map((r) => ({
            documentId: row.id,
            content: r.content,
            embedding: r.embedding,
            chunkIndex: r.chunkIndex,
            page: r.page,
            sectionTitle: r.sectionTitle,
            source: r.source,
            parentChunkId: r.parentChunkId,
            kind: r.kind,
            embeddingModel: r.embeddingModel,
            contentHash: r.contentHash,
          })),
        );
      }
      await tx.documents.setStorageKey(row.id, key);
      await tx.documents.updateIngestStatus(row.id, useAsync ? 'queued' : 'done');
      await tx.audit.logDocumentEvent({
        action: 'replace',
        documentId: row.id,
        actorId: input.actorId,
      });
      return row.id;
    });

    if (useAsync) {
      try {
        await deps.ingestQueue.enqueue({ documentId: newId });
      } catch (e) {
        await deps.documents.updateIngestStatus(newId, 'failed').catch(() => {});
        throw e;
      }
    }

    if (oldStorageKey) {
      await deps.blobStorage.delete(oldStorageKey).catch(() => {
        // Orphaned blob beats failing the replace.
      });
    }

    return ok({ documentId: newId, chunks: parsed?.value.chunks ?? 0, status: useAsync ? 'queued' : 'updated' });
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
