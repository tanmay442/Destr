import type { IngestQueue } from '@app/domain';

/** No-op `IngestQueue` for local dev when `QSTASH_TOKEN` is unset.
 *  The sync ingest path runs inside the upload request, so there is
 *  nothing to enqueue. `enqueue` resolves immediately. */
export function createSyncQueue(): IngestQueue {
  return {
    async enqueue() {
      // No-op: sync mode, ingest happens in the request.
    },
  };
}
