import type { IngestQueue } from '@app/domain';
import { createQstashQueue } from './qstash-queue';
import { createSyncQueue } from './sync-queue';

/** Factory: pick the QStash adapter when `QSTASH_TOKEN` is set,
 *  otherwise the no-op sync adapter. The async path is opt-in —
 *  without a token all uploads go through the synchronous ingest. */
export function createIngestQueue(): IngestQueue {
  if (process.env.QSTASH_TOKEN) return createQstashQueue();
  return createSyncQueue();
}

export { createQstashQueue, createSyncQueue };
