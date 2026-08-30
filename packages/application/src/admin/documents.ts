import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  NotFoundError,
  ValidationError,
  GoneError,
  ConflictError,
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
  CursorPageInfo,
} from '@app/domain';
import {
  parseAndEmbed,
  writeChunks,
  replaceDocumentChunks,
  claimDocumentByName,
  nameStillClaimed,
  UPLOAD_CONFLICT_MESSAGE,
  type RowPrevious,
} from '../rag/ingest';
import type { IngestDeps, IngestResult } from '../rag/ingest';
import { RESTORE_WINDOW_MS, MAX_LIST_LIMIT } from '@app/domain';
import {
  decodeCursorAtBoundary,
  wrapServiceCall,
  serviceResult,
  sanitizePagination,
} from '../service-result';
import { requireAdminActor } from './authz';

function isDocumentNameConflict(error: unknown): boolean {
  const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pgError = wrapped.code ? wrapped : wrapped.cause;
  return pgError?.code === '23505' && pgError.constraint === 'documents_file_name_unique';
}

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
  cursor?: unknown;
  before?: unknown;
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
  } & CursorPageInfo>
> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    const cursor = decodeCursorAtBoundary(input.cursor, 'documents');
    const before = decodeCursorAtBoundary(input.before, 'documents');
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const { documents, total, nextCursor, previousCursor } = await deps.documents.list({
      search: input.search,
      includeDeleted: input.includeDeleted,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
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
    return ok({
      documents: result,
      total,
      nextCursor: nextCursor ?? null,
      previousCursor: previousCursor ?? null,
    });
  }, 'Failed to list documents');
}

/** ≥4 MB uses the async QStash path (when async ingest is enabled). */
const ASYNC_INGEST_THRESHOLD = 4 * 1024 * 1024;

async function rollbackEnqueueFailure(
  row: { id: number; fileHash: string; storageKey: string },
  previous: RowPrevious,
  deps: { documents: DocumentRepository; blobStorage: BlobStorage },
): Promise<void> {
  let rolledBack = false;
  if (deps.documents.restoreAfterQueueFailure) {
    rolledBack = await deps.documents
      .restoreAfterQueueFailure(
        row.id,
        { fileHash: row.fileHash, storageKey: row.storageKey },
        {
          fileHash: previous.fileHash,
          ingestStatus: previous.status,
          storageKey: previous.storageKey,
        },
      )
      .catch(() => false);
  } else if (previous.fileHash) {
    rolledBack = await deps.documents
      .update(row.id, {
        fileHash: previous.fileHash,
        ingestStatus: previous.status ?? 'failed',
        storageKey: previous.storageKey,
      })
      .then(() => true)
      .catch(() => false);
  } else {
    rolledBack = await deps.documents
      .deleteById(row.id)
      .then(() => true)
      .catch(() => false);
  }
  if (rolledBack) {
    await deps.blobStorage.delete(row.storageKey).catch(() => {});
    return;
  }
  const current = await deps.documents.findById(row.id, { includeDeleted: true }).catch(() => null);
  if (!current || current.storageKey !== row.storageKey) {
    await deps.blobStorage.delete(row.storageKey).catch(() => {});
  }
}

async function cleanupUncommittedBlob(
  key: string,
  deps: { blobStorage: BlobStorage },
): Promise<void> {
  await deps.blobStorage.delete(key).catch(() => {});
}

async function putUncommittedBlob(
  key: string,
  body: Buffer,
  deps: { blobStorage: BlobStorage },
): Promise<void> {
  try {
    await deps.blobStorage.put(key, body, 'application/pdf');
  } catch (cause) {
    await cleanupUncommittedBlob(key, deps);
    throw cause;
  }
}

export async function uploadPdf(
  input: { fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue; users: UserRepository; asyncIngest: boolean },
): Promise<Result<IngestResult>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    if (input.buffer.length >= ASYNC_INGEST_THRESHOLD && deps.asyncIngest) {
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
  const key = newBlobKey(input.fileName);
  await putUncommittedBlob(key, input.buffer, deps);
  let parsed: Awaited<ReturnType<typeof parseAndEmbed>>;
  try {
    parsed = await parseAndEmbed({ fileName: input.fileName, buffer: input.buffer }, deps);
  } catch (cause) {
    await cleanupUncommittedBlob(key, deps);
    throw cause;
  }
  if (!parsed.ok) {
    await cleanupUncommittedBlob(key, deps);
    return parsed;
  }
  let oldStorageKey: string | null = null;
  let result: Result<IngestResult>;
  try {
    result = await deps.runner.run(async (tx) => {
      const claim = await claimDocumentByName(input.fileName, fileHash, tx.documents);
      if (claim.kind === 'unchanged') {
        if (claim.restore) {
          await tx.documents.restore(claim.documentId);
          await tx.audit.logDocumentEvent({ action: 'restore', documentId: claim.documentId, actorId: input.actorId });
        }
        return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
      }
      if (claim.kind === 'replace' || claim.kind === 'resurrect') {
        oldStorageKey = claim.previous.storageKey;
      } else {
        oldStorageKey = claim.oldStorageKey;
      }
      const outcome = await writeChunks(
        tx.documents,
        tx.chunks,
        {
          fileName: input.fileName,
          fileHash,
          uploadedBy: input.actorId,
          resurrectDeleted: claim.kind === 'resurrect',
        },
        parsed.value.rows,
      );
      if (!(await nameStillClaimed(input.fileName, fileHash, tx.documents))) {
        throw new ConflictError(UPLOAD_CONFLICT_MESSAGE);
      }
      await tx.documents.setStorageKey(outcome.documentId, key);
      await tx.audit.logDocumentEvent({
        action: claim.kind === 'replace' ? 'replace' : 'upload',
        documentId: outcome.documentId,
        actorId: input.actorId,
      });
      return ok({
        documentId: outcome.documentId,
        chunks: parsed.value.chunks,
        status: claim.kind === 'replace' ? 'updated' : 'inserted',
      });
    });
  } catch (e) {
    await cleanupUncommittedBlob(key, deps);
    if (isDocumentNameConflict(e)) return err(new ConflictError(UPLOAD_CONFLICT_MESSAGE));
    throw e;
  }
  if (!result.ok) {
    await cleanupUncommittedBlob(key, deps);
    return result;
  }
  if (result.value.status === 'unchanged') {
    await cleanupUncommittedBlob(key, deps);
    return result;
  }
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
  const fileHash = deps.hasher.sha256(input.buffer);
  const key = newBlobKey(input.fileName);
  await putUncommittedBlob(key, input.buffer, deps);
  let previous: RowPrevious = { fileHash: null, status: null, storageKey: null };
  let oldStorageKey: string | null = null;
  let result: Result<IngestResult>;
  try {
    result = await deps.runner.run(async (tx) => {
      const claim = await claimDocumentByName(input.fileName, fileHash, tx.documents);
      if (claim.kind === 'unchanged') {
        if (claim.restore) {
          await tx.documents.restore(claim.documentId);
          await tx.audit.logDocumentEvent({ action: 'restore', documentId: claim.documentId, actorId: input.actorId });
        }
        return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
      }
      if (claim.kind === 'replace' || claim.kind === 'resurrect') {
        previous = claim.previous;
        oldStorageKey = claim.previous.storageKey;
      } else {
        oldStorageKey = claim.oldStorageKey;
      }
      if (claim.kind === 'resurrect') await tx.documents.restore(claim.documentId);
      const doc =
        claim.kind === 'insert'
          ? await tx.documents.insert(
              { fileName: input.fileName, fileHash, uploadedBy: input.actorId },
              { resurrectDeleted: false },
            )
          : await tx.documents.update(claim.documentId, { fileName: input.fileName, fileHash, uploadedBy: input.actorId });
      if (!(await nameStillClaimed(input.fileName, fileHash, tx.documents))) {
        throw new ConflictError(UPLOAD_CONFLICT_MESSAGE);
      }
      await tx.documents.setStorageKey(doc.id, key);
      await tx.documents.updateIngestStatus(doc.id, 'queued');
      const a = auditFor(doc.id);
      await tx.audit.logDocumentEvent({ action: a.action, documentId: a.documentId, actorId: input.actorId });
      return ok({ documentId: doc.id, chunks: 0, status: 'queued' });
    });
  } catch (e) {
    await cleanupUncommittedBlob(key, deps);
    if (isDocumentNameConflict(e)) return err(new ConflictError(UPLOAD_CONFLICT_MESSAGE));
    throw e;
  }
  if (!result.ok) {
    await cleanupUncommittedBlob(key, deps);
    return result;
  }
  if (result.value.status === 'unchanged') {
    await cleanupUncommittedBlob(key, deps);
    return result;
  }
  if (result.value.status === 'queued') {
    try {
      await deps.ingestQueue.enqueue({ documentId: result.value.documentId, fileHash, attemptId: randomUUID() });
    } catch (e) {
      await rollbackEnqueueFailure(
        { id: result.value.documentId, fileHash, storageKey: key },
        previous,
        deps,
      );
      throw e;
    }
  }
  if (oldStorageKey) {
    await deps.blobStorage.delete(oldStorageKey).catch(() => {});
  }
  return result;
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
  deps: { documents: DocumentRepository; audit: AuditLog; clock: Clock; runner: TransactionRunner; users: UserRepository },
): Promise<Result<void>> {
  const authz = await requireAdminActor(actorId, { users: deps.users });
  if (!authz.ok) return authz;
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
      await deps.blobStorage.delete(storageKey).catch(() => {});
    }
    return ok(undefined);
  }, 'Failed to hard-delete document');
}

export async function replacePdf(
  input: { documentId: number; fileName: string; buffer: Buffer; actorId: string },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue; users: UserRepository; asyncIngest: boolean },
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

    const oldStorageKey = existing.storageKey;
    const key = newBlobKey(input.fileName);
    await putUncommittedBlob(key, input.buffer, deps);

    const useAsync = input.buffer.length >= ASYNC_INGEST_THRESHOLD && deps.asyncIngest;
    const previous = {
      fileHash: existing.fileHash,
      status: existing.ingestStatus,
      storageKey: existing.storageKey,
    };
    let parsed: Awaited<ReturnType<typeof parseAndEmbed>> | null = null;
    if (!useAsync) {
      try {
        parsed = await parseAndEmbed(
          { fileName: input.fileName, buffer: input.buffer },
          deps,
        );
      } catch (cause) {
        await cleanupUncommittedBlob(key, deps);
        throw cause;
      }
      if (!parsed.ok) {
        await cleanupUncommittedBlob(key, deps);
        return parsed;
      }
    }

    let rowId: number;
    try {
      rowId = await deps.runner.run(async (tx) => {
        const patch = {
          fileName: input.fileName,
          fileHash,
          uploadedBy: input.actorId,
        };
        if (tx.documents.updateIfCurrent) {
          const updated = await tx.documents.updateIfCurrent(input.documentId, existing.fileHash, patch);
          if (!updated) throw new ConflictError('The document changed while it was being replaced; retry the operation');
        } else {
          await tx.documents.update(input.documentId, patch);
        }
        if (parsed) {
          await replaceDocumentChunks(
            tx.chunks,
            input.documentId,
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
        await deps.ingestQueue.enqueue({ documentId: rowId, fileHash, attemptId: randomUUID() });
      } catch (e) {
        await rollbackEnqueueFailure({ id: rowId, fileHash, storageKey: key }, previous, deps);
        throw e;
      }
    }

    if (oldStorageKey) {
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
