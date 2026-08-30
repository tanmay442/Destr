import { randomUUID } from 'node:crypto';
import { ok, err, type Result, ExternalServiceError } from '@app/domain';
import type { DocumentRepository, ChunkRepository, IngestQueue } from '@app/domain';
import { MAX_LIST_LIMIT } from '@app/domain';

export interface ReingestDeps {
  documents: DocumentRepository;
  queue: IngestQueue;
  /** Retained for compatibility with callers that pass a chunk repository. */
  chunks?: ChunkRepository;
}

export interface ReingestSummary {
  enqueued: number;
  documentIds: number[];
}

/**
 * Re-enqueue every non-deleted document for a full re-ingest against the
 * current strategy/model. Each doc is reset to `queued` before enqueueing so
 * the worker re-parses instead of short-circuiting on the `done` status;
 * chunks are cleared only after the message is safely queued.
 */
export async function reingestAll(deps: ReingestDeps): Promise<Result<ReingestSummary>> {
  if (deps.queue.isNoOp()) {
    return err(
      new ExternalServiceError(
        'Re-ingest refused: the ingest queue is a no-op (no QStash worker wired). ' +
          'Set QSTASH_TOKEN (and QSTASH_INGEST_WORKER_URL) so documents are actually re-ingested.',
      ),
    );
  }
  try {
    const documentIds: number[] = [];
    let offset = 0;
    const limit = MAX_LIST_LIMIT;

    while (true) {
      const { documents, total } = await deps.documents.list({
        includeDeleted: false,
        limit,
        offset,
      });
      for (const doc of documents) {
        if (doc.ingestStatus === 'ingesting') continue;
        const attemptId = randomUUID();
        let statusChanged = false;
        try {
          if (deps.documents.updateIngestStatusIfCurrent) {
            const changed = await deps.documents.updateIngestStatusIfCurrent(
              doc.id,
              doc.fileHash,
              doc.ingestStatus,
              'queued',
            );
            if (!changed) continue;
            statusChanged = true;
          } else if (doc.ingestStatus !== 'queued') {
            await deps.documents.update(doc.id, { ingestStatus: 'queued' });
            statusChanged = true;
          }
          await deps.queue.enqueue({ documentId: doc.id, fileHash: doc.fileHash, attemptId });
        } catch (e) {
          if (statusChanged) {
            if (deps.documents.updateIngestStatusIfCurrent) {
              await deps.documents
                .updateIngestStatusIfCurrent(doc.id, doc.fileHash, 'queued', doc.ingestStatus)
                .catch(() => {});
            } else {
              await deps.documents.update(doc.id, { ingestStatus: doc.ingestStatus }).catch(() => {});
            }
          }
          return err(new ExternalServiceError(`Failed to enqueue document ${doc.id}`, e));
        }
        documentIds.push(doc.id);
      }
      offset += documents.length;
      if (offset >= total || documents.length === 0) break;
    }

    return ok({ enqueued: documentIds.length, documentIds });
  } catch (e) {
    return err(new ExternalServiceError('Failed to reingest documents', e));
  }
}
