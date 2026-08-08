import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  NotFoundError,
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
  Hasher,
  DocumentRow,
} from '@app/domain';
import { ingestFile, parseAndEmbed } from '../rag/ingest';
import type { IngestDeps, IngestResult } from '../rag/ingest';
import { RESTORE_WINDOW_MS, MAX_LIST_LIMIT } from '@app/domain';
import { wrapServiceCall, serviceResult, sanitizePagination } from '../service-result';
import { requireAdminActor } from './authz';

/** Generate a unique blob-storage key for the given filename. */
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
  search?: string | undefined;
  includeDeleted?: boolean | undefined;
  limit?: number;
  offset?: number;
}

export async function listDocuments(
  input: ListDocumentsInput & { actorId: string },
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
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
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

/** ≥4 MB uses the async QStash path (when QSTASH_TOKEN is set). */
const ASYNC_INGEST_THRESHOLD = 4 * 1024 * 1024;

/** Returns true when QSTASH_TOKEN is set. */
function asyncIngestEnabled(): boolean {
  return Boolean(process.env.QSTASH_TOKEN);
}

interface PreparedReplacement {
  fileHash: string;
  key: string;
  oldStorageKey: string | null;
}

/**
 * Shared blob-before-tx + dedup-by-hash logic for both upload-by-name and
 * replace-by-id. Uploads the new blob first, dedups identical content, and
 * returns the new storage key plus the superseded key for post-commit cleanup.
 */
async function prepareReplacementBlob(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: { hasher: Hasher; blobStorage: BlobStorage; documents: DocumentRepository },
  existing: { id: number; fileHash: string; storageKey: string | null } | null,
): Promise<Result<{ unchanged: true; documentId: number } | ({ unchanged: false } & PreparedReplacement)>> {
  const fileHash = deps.hasher.sha256(input.buffer);
  if (existing && existing.fileHash === fileHash) {
    return ok({ unchanged: true, documentId: existing.id });
  }
  const key = newBlobKey(input.fileName);
  await deps.blobStorage.put(key, input.buffer, 'application/pdf');
  return ok({ unchanged: false, fileHash, key, oldStorageKey: existing?.storageKey ?? null });
}

/**
 * Look up the upload target by name *including* soft-deleted rows so a re-upload
 * correctly reuses (within `RESTORE_WINDOW_MS`) or supersedes (beyond it) the
 * previous generation instead of silently resurrecting it or orphaning its blob.
 */
async function resolveUploadTarget(
  fileName: string,
  deps: { documents: DocumentRepository },
): Promise<{ doc: DocumentRow | null; supersededKey: string | null }> {
  const found = await deps.documents.findByName(fileName, { includeDeleted: true });
  if (!found) return { doc: null, supersededKey: null };
  if (found.deletedAt && Date.now() - found.deletedAt.getTime() > RESTORE_WINDOW_MS) {
    return { doc: null, supersededKey: found.storageKey };
  }
  return { doc: found, supersededKey: found.storageKey };
}

/** Roll an enqueued document back so a failed publish is not a dead end:
 *  reused rows restore their previous hash/status; brand-new rows are removed
 *  (row + blob) so a retry re-uploads from scratch. */
async function rollbackEnqueueFailure(
  row: { id: number; storageKey: string | null },
  previous: { fileHash: string | null; status: IngestStatus | null },
  deps: { documents: DocumentRepository; blobStorage: BlobStorage },
): Promise<void> {
  if (previous.fileHash) {
    await deps.documents
      .update(row.id, { fileHash: previous.fileHash, ingestStatus: previous.status ?? 'failed' })
      .catch(() => {});
    return;
  }
  const key = row.storageKey;
  await deps.documents.deleteById(row.id).catch(() => {});
  if (key) await deps.blobStorage.delete(key).catch(() => {});
}

/** Delete a freshly-uploaded blob when its document write never committed. */
async function cleanupUncommittedBlob(
  key: string,
  deps: { blobStorage: BlobStorage },
): Promise<void> {
  await deps.blobStorage.delete(key).catch(() => {});
}

export async function uploadPdf(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue; users: UserRepository },
): Promise<Result<IngestResult>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
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
  const target = await resolveUploadTarget(input.fileName, deps);
  const existing = target.doc;
  if (existing && existing.fileHash === fileHash) {
    if (existing.deletedAt) await deps.documents.restore(existing.id);
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }
  const oldStorageKey = existing?.storageKey ?? target.supersededKey;
  // Upload blob BEFORE the DB tx so a rollback never orphans a committed row's blob.
  const key = newBlobKey(input.fileName);
  await deps.blobStorage.put(key, input.buffer, 'application/pdf');
  let result: Result<IngestResult>;
  try {
    result = await deps.runner.run(async (tx) => {
      const res = await ingestFile(
        { fileName: input.fileName, buffer: input.buffer, uploadedBy: input.actorId },
        {
          ...deps,
          documents: tx.documents,
          chunks: tx.chunks,
          runner: { run: (fn) => fn(tx) },
        },
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
  } catch (e) {
    await cleanupUncommittedBlob(key, deps);
    throw e;
  }
  if (!result.ok) {
    await cleanupUncommittedBlob(key, deps);
    return result;
  }
  // Delete superseded blob after the new row has committed.
  if (oldStorageKey) {
    // Best-effort cleanup: orphaned blob beats failing the upload.
    await deps.blobStorage.delete(oldStorageKey).catch(() => {});
  }
  return result;
}

async function queuePdfForIngest(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
  auditFor: (newDocumentId: number) => { action: 'upload' | 'replace'; documentId: number },
): Promise<Result<IngestResult>> {
  const target = await resolveUploadTarget(input.fileName, deps);
  const existing = target.doc;
  const prepared = await prepareReplacementBlob(input, deps, existing);
  if (!prepared.ok) return prepared;
  if (prepared.value.unchanged) {
    if (existing?.deletedAt) await deps.documents.restore(existing.id);
    return ok({ documentId: prepared.value.documentId, chunks: 0, status: 'unchanged' });
  }
  const { fileHash, key } = prepared.value;
  const oldStorageKey = prepared.value.oldStorageKey ?? target.supersededKey;
  const previous = {
    fileHash: existing?.fileHash ?? null,
    status: existing?.ingestStatus ?? null,
  };
  let row: DocumentRow;
  try {
    row = await deps.runner.run(async (tx) => {
      // Reuse the existing id (upsert-in-place) so references stay stable.
      const doc = existing
        ? await tx.documents.update(existing.id, { fileName: input.fileName, fileHash, uploadedBy: input.actorId })
        : await tx.documents.insert({ fileName: input.fileName, fileHash, uploadedBy: input.actorId });
      await tx.documents.setStorageKey(doc.id, key);
      await tx.documents.updateIngestStatus(doc.id, 'queued');
      const a = auditFor(doc.id);
      await tx.audit.logDocumentEvent({ action: a.action, documentId: a.documentId, actorId: input.actorId });
      return doc;
    });
  } catch (e) {
    await cleanupUncommittedBlob(key, deps);
    throw e;
  }
  if (oldStorageKey) {
    // Best-effort cleanup: orphaned blob beats blocking the re-upload.
    await deps.blobStorage.delete(oldStorageKey).catch(() => {});
  }
  try {
    await deps.ingestQueue.enqueue({ documentId: row.id });
  } catch (e) {
    await rollbackEnqueueFailure({ id: row.id, storageKey: key }, previous, deps);
    throw e;
  }
  return ok({ documentId: row.id, chunks: 0, status: 'queued' });
}

export async function softDeleteDocument(
  input: { documentId: number; actorId: string },
  deps: { documents: DocumentRepository; audit: AuditLog; runner: TransactionRunner; users: UserRepository },
): Promise<Result<void>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
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
  deps: { documents: DocumentRepository; audit: AuditLog; clock: Clock; runner: TransactionRunner; users?: UserRepository },
): Promise<Result<void>> {
  if (deps.users) {
    const authz = await requireAdminActor(actorId, { users: deps.users });
    if (!authz.ok) return authz;
  }
  return wrapServiceCall(async () => {
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
  }, 'Failed to restore document');
}

export async function getDocumentById(
  documentId: number,
  deps: { documents: DocumentRepository },
  opts: { includeDeleted?: boolean | undefined } = {},
): Promise<Result<{ document: import('@app/domain').DocumentRow | null }>> {
  return serviceResult(
    () => deps.documents.findById(documentId, opts).then((doc) => ({ document: doc })),
    'Failed to get document',
  );
}

export async function hardDeleteDocument(
  input: { documentId: number; actorId: string },
  deps: { documents: DocumentRepository; audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; users: UserRepository },
): Promise<Result<void>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
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
      // Best-effort cleanup: orphaned blob beats failing the hard-delete.
      await deps.blobStorage.delete(storageKey).catch(() => {});
    }
    return ok(undefined);
  }, 'Failed to hard-delete document');
}

export async function replacePdf(
  input: { documentId: number; fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue; users: UserRepository },
): Promise<Result<IngestResult>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async (): Promise<Result<IngestResult>> => {
    const existing = await deps.documents.findById(input.documentId);
    if (!existing) return err(new NotFoundError(`Document not found: ${input.documentId}`));

    const fileHash = deps.hasher.sha256(input.buffer);
    if (existing.fileHash === fileHash) {
      return ok({ documentId: input.documentId, chunks: 0, status: 'unchanged' });
    }

    // Resolve by documentId (never by fileName) and reuse the row in place
    // so bookmarks/audit/queued references stay stable across sync/async paths.
    const oldStorageKey = existing.storageKey;
    const key = newBlobKey(input.fileName);
    await deps.blobStorage.put(key, input.buffer, 'application/pdf');

    const useAsync = input.buffer.length >= ASYNC_INGEST_THRESHOLD && asyncIngestEnabled();
    const previous = { fileHash: existing.fileHash, status: existing.ingestStatus };
    let parsed: Awaited<ReturnType<typeof parseAndEmbed>> | null = null;
    if (!useAsync) {
      parsed = await parseAndEmbed(
        { fileName: input.fileName, buffer: input.buffer },
        deps,
      );
      if (!parsed.ok) return parsed;
    }

    let rowId: number;
    try {
      rowId = await deps.runner.run(async (tx) => {
        await tx.documents.update(input.documentId, {
          fileName: input.fileName,
          fileHash,
          uploadedBy: input.actorId,
        });
        if (parsed) {
          await tx.chunks.deleteByDocumentId(input.documentId);
          await tx.chunks.insertMany(
            parsed.value.rows.map((r) => ({
              documentId: input.documentId,
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
        await tx.documents.setStorageKey(input.documentId, key);
        await tx.documents.updateIngestStatus(input.documentId, useAsync ? 'queued' : 'done');
        await tx.audit.logDocumentEvent({
          action: 'replace',
          documentId: input.documentId,
          actorId: input.actorId,
        });
        return input.documentId;
      });
    } catch (e) {
      await cleanupUncommittedBlob(key, deps);
      throw e;
    }

    if (useAsync) {
      try {
        await deps.ingestQueue.enqueue({ documentId: rowId });
      } catch (e) {
        await rollbackEnqueueFailure({ id: rowId, storageKey: key }, previous, deps);
        throw e;
      }
    }

    if (oldStorageKey) {
      // Best-effort cleanup: orphaned blob beats failing the replace.
      await deps.blobStorage.delete(oldStorageKey).catch(() => {});
    }

    return ok({ documentId: rowId, chunks: parsed?.value.chunks ?? 0, status: useAsync ? 'queued' : 'updated' });
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
