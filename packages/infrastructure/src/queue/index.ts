import type { IngestQueue } from '@app/domain';
import './qstash-queue';
import './sync-queue';
import { ingestQueueRegistry } from './ingest-queue-registry';
import { createSyncQueue, type SyncQueueOptions } from './sync-queue';
import { createQstashQueue } from './qstash-queue';
import { createQueuedSweeper, type QueuedSweeper, type QueuedSweeperDeps, type QueuedSweeperOptions } from './queued-sweeper';

export function createIngestQueue(opts: SyncQueueOptions = {}): IngestQueue {
  const provider = process.env.QSTASH_TOKEN ? 'qstash' : 'sync';
  const factory = ingestQueueRegistry.get(provider);
  if (!factory) throw new Error(`Unknown ingest queue provider: ${provider}`);
  return factory(opts);
}

export { createQstashQueue, createSyncQueue, createQueuedSweeper };
export type { SyncQueueOptions, QueuedSweeper, QueuedSweeperDeps, QueuedSweeperOptions };
