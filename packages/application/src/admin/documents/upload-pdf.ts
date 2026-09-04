import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  ConflictError,
} from '@app/domain';
import type {
  AuditLog,
  UserRepository,
  TransactionRunner,
  BlobStorage,
  IngestQueue,
} from '@app/domain';
import {
  parseAndEmbed,
  writeChunks,
  claimDocumentByName,
  nameStillClaimed,
  UPLOAD_CONFLICT_MESSAGE,
  type RowPrevious,
} from '../../rag/ingest';
import type { IngestDeps, IngestResult } from '../../rag/ingest';
import { wrapServiceCall } from '../../service-result';
import { requireAdminActor } from '../authz';
import { ASYNC_INGEST_THRESHOLD, isDocumentNameConflict, newBlobKey, rollbackEnqueueFailure, cleanupUncommittedBlob, putUncommittedBlob } from './blob-store';

export async function uploadPdf(
  input: { fileName: string; buffer: Buffer; actorId: string; signal?: AbortSignal | undefined },
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue; users: UserRepository; asyncIngest: boolean },
): Promise<Result<IngestResult>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    // Hash once at the upload boundary and carry it through every ingest path.
    // The queued worker may independently verify the stored blob later, but
    // this request must not hash the same full buffer in each branch.
    const fileHash = deps.hasher.sha256(input.buffer);
    const unchanged = await completeUnchangedUpload(input, fileHash, deps);
    if (unchanged !== null) return unchanged;
    if (input.buffer.length >= ASYNC_INGEST_THRESHOLD && deps.asyncIngest) {
      return queuePdfForIngest(input, fileHash, deps, (newId) => ({ action: 'upload', documentId: newId }));
    }
    return uploadPdfSync(input, fileHash, deps);
  }, 'Failed to upload PDF');
}

async function completeUnchangedUpload(
  input: { fileName: string; buffer: Buffer; actorId: string },
  fileHash: string,
  deps: Pick<IngestDeps, 'documents'> & { runner: TransactionRunner },
): Promise<Result<IngestResult> | null> {
  const candidate = await deps.documents.findByName(input.fileName, { includeDeleted: true });
  if (candidate?.fileHash !== fileHash) return null;

  return deps.runner.run(async (tx) => {
    const claim = await claimDocumentByName(input.fileName, fileHash, tx.documents);
    if (claim.kind !== 'unchanged') return null;
    if (claim.restore) {
      await tx.documents.restore(claim.documentId);
      await tx.audit.logDocumentEvent({
        action: 'restore',
        documentId: claim.documentId,
        actorId: input.actorId,
      });
    }
    return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
  });
}

async function uploadPdfSync(
  input: { fileName: string; buffer: Buffer; actorId: string; signal?: AbortSignal | undefined },
  fileHash: string,
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage },
): Promise<Result<IngestResult>> {
  const key = newBlobKey(input.fileName);
  await putUncommittedBlob(key, input.buffer, deps);
  let parsed: Awaited<ReturnType<typeof parseAndEmbed>>;
  try {
    parsed = await parseAndEmbed({ fileName: input.fileName, buffer: input.buffer, signal: input.signal }, deps);
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
  fileHash: string,
  deps: IngestDeps & { audit: AuditLog; runner: TransactionRunner; blobStorage: BlobStorage; ingestQueue: IngestQueue },
  auditFor: (newDocumentId: number) => { action: 'upload' | 'replace'; documentId: number },
): Promise<Result<IngestResult>> {
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
