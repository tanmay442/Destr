import { describe, vi } from 'vitest';
import { createSyncQueue } from '../../sync-queue';
import { runIngestQueueContract } from './ingest-queue-contract';

describe('sync queue contract — inline mode', () => {
  const ingest = vi.fn().mockResolvedValue(undefined);
  runIngestQueueContract(() => createSyncQueue({ ingest }), {
    expectNoOp: false,
    inlineIngest: ingest,
  });
});

describe('sync queue contract — no-op mode', () => {
  runIngestQueueContract(() => createSyncQueue(), { expectNoOp: true });
});
