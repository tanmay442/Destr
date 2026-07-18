import type { IngestQueue } from '@app/domain';

export interface SyncQueueOptions {
  ingest?: (documentId: number) => Promise<void>;
}

export function createSyncQueue(opts: SyncQueueOptions = {}): IngestQueue {
  const env = process.env.NODE_ENV ?? 'development';
  const isProd = env === 'production';
  if (!opts.ingest) {
    console.warn(
      '[ingest-queue] Sync (no-op) queue is active. Documents enqueued here will NOT be ingested. ' +
        'Set QSTASH_TOKEN to enable async ingest.' +
        (isProd ? ' Running in production without QSTASH_TOKEN means uploads never get chunked/embedded.' : ''),
    );
  }
  return {
    async enqueue({ documentId }) {
      if (opts.ingest) {
        await opts.ingest(documentId);
        return;
      }
      console.warn(
        `[ingest-queue] enqueue(${documentId}) is a no-op: document will not be ingested. ` +
          'Set QSTASH_TOKEN to enable async ingest.',
      );
    },
    isNoOp() {
      return !opts.ingest;
    },
  };
}
