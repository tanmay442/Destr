import { ok, type Result } from '@app/domain';
import type { DocumentRepository, IngestQueue } from '@app/domain';
import { MAX_LIST_LIMIT } from '../../../../config/constants';

export interface ReingestDeps {
  documents: DocumentRepository;
  queue: IngestQueue;
}

export interface ReingestSummary {
  enqueued: number;
  documentIds: number[];
}

/**
 * Re-enqueue every non-deleted document for a full re-ingest against the
 * *current* strategy/model. Pagination is driven entirely by the repository's
 * `total`, so the caller never has to guess how many pages exist. Each doc is
 * enqueued exactly once; the existing QStash worker does the parse → split →
 * embed → atomic chunk replace — this use-case holds no ingest logic.
 */
export async function reingestAll(deps: ReingestDeps): Promise<Result<ReingestSummary>> {
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
      await deps.queue.enqueue({ documentId: doc.id });
      documentIds.push(doc.id);
    }
    offset += documents.length;
    if (offset >= total || documents.length === 0) break;
  }

  return ok({ enqueued: documentIds.length, documentIds });
}
