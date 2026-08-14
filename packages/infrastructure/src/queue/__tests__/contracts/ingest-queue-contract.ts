import { describe, it, expect } from 'vitest';
import type { IngestQueue } from '@app/domain';

export interface IngestQueueContractOptions {
  /** Expected `isNoOp()` result for this implementation. */
  expectNoOp: boolean;
  /**
   * Sync-inline mode: the spy the test file wired as the queue's ingest
   * callback. When provided, the harness asserts enqueue hands it the id.
   */
  inlineIngest?: (documentId: number) => Promise<void>;
}

/**
 * Shared contract assertions every IngestQueue implementation must satisfy.
 * Sync-inline queues pass their `ingest` spy as `inlineIngest`; remote
 * publishers (QStash) assert request shape in their own impl test file.
 */
export function runIngestQueueContract(
  makeQueue: () => IngestQueue,
  opts: IngestQueueContractOptions,
): void {
  describe('ingest queue contract', () => {
    it('enqueues a document id successfully', async () => {
      const queue = makeQueue();
      await expect(queue.enqueue({ documentId: 42 })).resolves.toBeUndefined();
    });

    it('reports the expected no-op semantics', () => {
      expect(makeQueue().isNoOp()).toBe(opts.expectNoOp);
    });

    if (opts.inlineIngest) {
      it('runs the ingest inline with the document id (sync mode)', async () => {
        const queue = makeQueue();
        await queue.enqueue({ documentId: 7 });
        expect(opts.inlineIngest).toHaveBeenCalledWith(7);
      });
    }

    if (opts.expectNoOp) {
      it('enqueues without invoking any ingest path (no-op mode)', async () => {
        const queue = makeQueue();
        await queue.enqueue({ documentId: 9 });
        if (opts.inlineIngest) {
          expect(opts.inlineIngest).not.toHaveBeenCalled();
        }
      });
    }
  });
}
