import type { IngestQueue } from '@app/domain';

export function createSyncQueue(): IngestQueue {
  return {
    async enqueue() {},
  };
}
