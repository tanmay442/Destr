import { randomUUID } from 'crypto';
import type {
  DocumentRepository,
  BlobStorage,
} from '@app/domain';
import type { RowPrevious } from '../../rag/ingest';

/** ≥4 MB uses the async QStash path (when async ingest is enabled). */
const ASYNC_INGEST_THRESHOLD = 4 * 1024 * 1024;

export { ASYNC_INGEST_THRESHOLD };

function isDocumentNameConflict(error: unknown): boolean {
  const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pgError = wrapped.code ? wrapped : wrapped.cause;
  return pgError?.code === '23505' && pgError.constraint === 'documents_file_name_unique';
}

export { isDocumentNameConflict };

function newBlobKey(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `docs/${randomUUID()}/${safe}`;
}

export { newBlobKey };

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

export { rollbackEnqueueFailure };

async function cleanupUncommittedBlob(
  key: string,
  deps: { blobStorage: BlobStorage },
): Promise<void> {
  await deps.blobStorage.delete(key).catch(() => {});
}

export { cleanupUncommittedBlob };

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

export { putUncommittedBlob };
