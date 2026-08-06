import { ok, err, type Result, ExternalServiceError } from '@app/domain';
import type { DocumentRepository, ChunkRepository, IngestQueue } from '@app/domain';
import { MAX_LIST_LIMIT } from '../../../../config/constants';

export interface ReingestDeps {
  documents: DocumentRepository;
  queue: IngestQueue;
  /** Optional: when provided, chunks are dropped before re-enqueue so the
   *  worker's insert cannot double the index (worker-side delete is the primary
   *  guard; this is defense-in-depth for callers that own a chunk repo). */
  chunks?: ChunkRepository;
}

export interface ReingestSummary {
  enqueued: number;
  documentIds: number[];
}

/**
 * Re-enqueue every non-deleted document for a full re-ingest against the
 * current strategy/model. Each doc is reset to `queued` (and its chunks
 * cleared when a chunk repo is available) before enqueueing, so the worker
 * actually re-parses instead of short-circuiting on the `done` status.
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
        try {
          if (doc.ingestStatus !== 'queued') {
            await deps.documents.update(doc.id, { ingestStatus: 'queued' });
          }
          if (deps.chunks) await deps.chunks.deleteByDocumentId(doc.id);
          await deps.queue.enqueue({ documentId: doc.id });
        } catch (e) {
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
