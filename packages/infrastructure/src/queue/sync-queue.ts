import { logger, type IngestQueue } from '@app/domain';
import { registerIngestQueueProvider } from './ingest-queue-registry';

export interface SyncQueueOptions {
  ingest?: (documentId: number, fileHash?: string) => Promise<void>;
}

export function createSyncQueue(opts: SyncQueueOptions = {}): IngestQueue {
  const env = process.env.NODE_ENV ?? 'development';
  const isProd = env === 'production';
  if (!opts.ingest) {
    logger.warn(
      '[ingest-queue] Sync (no-op) queue is active. Documents enqueued here will NOT be ingested. ' +
        'Set QSTASH_TOKEN to enable async ingest.' +
        (isProd ? ' Running in production without QSTASH_TOKEN means uploads never get chunked/embedded.' : ''),
    );
  }
  return {
    async enqueue({ documentId, fileHash }: { documentId: number; fileHash?: string; attemptId?: string }) {
      if (opts.ingest) {
        if (fileHash === undefined) await opts.ingest(documentId);
        else await opts.ingest(documentId, fileHash);
        return;
      }
      logger.warn(
        `[ingest-queue] enqueue(${documentId}) is a no-op: document will not be ingested. ` +
          'Set QSTASH_TOKEN to enable async ingest.',
      );
    },
    isNoOp() {
      return !opts.ingest;
    },
  };
}

registerIngestQueueProvider('sync', createSyncQueue);
