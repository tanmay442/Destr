import type { IngestQueue } from '@app/domain';
import { createQstashQueue } from './qstash-queue';
import { createSyncQueue } from './sync-queue';

export function createIngestQueue(): IngestQueue {
  if (process.env.QSTASH_TOKEN) return createQstashQueue();
  return createSyncQueue();
}

export { createQstashQueue, createSyncQueue };
