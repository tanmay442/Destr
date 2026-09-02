import { randomUUID } from 'node:crypto';
import { ok, err, type Result, ExternalServiceError, createListCursorContext } from '@app/domain';
import type {
  DocumentListCursor,
  DocumentRepository,
  ChunkRepository,
  IngestQueue,
  ListCursorCodec,
} from '@app/domain';
import { MAX_LIST_LIMIT } from '@app/domain';
import { decodeCursorAtBoundary } from '../service-result';

export interface ReingestDeps {
  documents: DocumentRepository;
  queue: IngestQueue;
  /** Signed cursor dependencies for the repository's paged list output. */
  cursorCodec: ListCursorCodec;
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
    const limit = MAX_LIST_LIMIT;
    const cursorContext = createListCursorContext('documents', { search: null, includeDeleted: false });
    let cursor: DocumentListCursor | undefined;

    while (true) {
      const page = await deps.documents.list({
        includeDeleted: false,
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        cursorCodec: deps.cursorCodec,
        cursorContext,
      });
      const { documents } = page;
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
      if (documents.length === 0 || page.nextCursor === null) break;
      cursor = decodeCursorAtBoundary(page.nextCursor, 'documents', deps.cursorCodec, cursorContext);
      if (cursor === undefined) break;
    }

    return ok({ enqueued: documentIds.length, documentIds });
  } catch (e) {
    return err(new ExternalServiceError('Failed to reingest documents', e));
  }
}
