import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  NotFoundError,
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
  replaceDocumentChunks,
} from '../../rag/ingest';
import type { IngestDeps, IngestResult } from '../../rag/ingest';
import { wrapServiceCall } from '../../service-result';
import { requireAdminActor } from '../authz';
import { ASYNC_INGEST_THRESHOLD, newBlobKey, rollbackEnqueueFailure, cleanupUncommittedBlob, putUncommittedBlob } from './blob-store';

export async function replacePdf(
  input: { documentId: number; fileName: string; buffer: Buffer; actorId: string; signal?: AbortSignal | undefined },
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
          { fileName: input.fileName, buffer: input.buffer, signal: input.signal },
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
