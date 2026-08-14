import type { IngestQueue } from '@app/domain';
import { createProviderRegistry } from '../registry';
import type { SyncQueueOptions } from './sync-queue';

export type IngestQueueProvider = (opts: SyncQueueOptions) => IngestQueue;

export const ingestQueueRegistry = createProviderRegistry<IngestQueueProvider>();

export function registerIngestQueueProvider(key: string, factory: IngestQueueProvider): void {
  ingestQueueRegistry.register(key, factory);
}
