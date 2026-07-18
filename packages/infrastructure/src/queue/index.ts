import type { IngestQueue } from '@app/domain';
import { createQstashQueue } from './qstash-queue';
import { createSyncQueue, type SyncQueueOptions } from './sync-queue';

export function createIngestQueue(opts: SyncQueueOptions = {}): IngestQueue {
  if (process.env.QSTASH_TOKEN) return createQstashQueue();
  return createSyncQueue(opts);
}

export { createQstashQueue, createSyncQueue };
export type { SyncQueueOptions };
