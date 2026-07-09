import type { IngestQueue } from '@app/domain';

/** No-op `IngestQueue` for local dev when `QSTASH_TOKEN` is unset.
 *  Sync ingest runs in the upload request, so nothing is enqueued. */
export function createSyncQueue(): IngestQueue {
  return {
    async enqueue() {},
  };
}
