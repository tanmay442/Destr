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
} from '@app/domain';
import { RESTORE_WINDOW_MS } from '@app/domain';
import {
  wrapServiceCall,
  serviceResult,
} from '../../service-result';
import { requireAdminActor } from '../authz';

async function ensureDocument(
  documentId: number,
  dep: DocumentRepository,
): Promise<Result<{ documentId: number }>> {
  const existing = await dep.findById(documentId);
  if (!existing) return err(new NotFoundError(`Document not found: ${documentId}`));
  return ok({ documentId });
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
