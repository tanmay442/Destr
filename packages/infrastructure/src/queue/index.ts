import type { IngestQueue } from '@app/domain';
import { createQstashQueue } from './qstash-queue';
import { createSyncQueue } from './sync-queue';

/** Factory: QStash when `QSTASH_TOKEN` is set, else the no-op sync adapter.
 *  Async ingest is opt-in; without a token uploads run synchronously. */
export function createIngestQueue(): IngestQueue {
  if (process.env.QSTASH_TOKEN) return createQstashQueue();
  return createSyncQueue();
}

export { createQstashQueue, createSyncQueue };
