export interface QueuedSweeperDeps {
  listStaleQueued(olderThan: Date): Promise<number[]>;
  failDocument(documentId: number): Promise<void>;
  failDocumentIfStale?: ((documentId: number, olderThan: Date) => Promise<boolean>) | undefined;
}

export interface QueuedSweeperOptions {
  ttlMs?: number;
}

export interface QueuedSweeper {
  sweep(now?: Date): Promise<{ failed: number }>;
}

const DEFAULT_STALE_QUEUED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sweeps documents that stayed `queued` past the TTL (e.g. QStash messages that
 * exhausted their retry budget without a DLQ) and marks them failed so the
 * stuck state is visible instead of silently permanent. Deps are injected so
 * the sweeper stays storage/queue-only; wiring lives at the composition root.
 */
export function createQueuedSweeper(deps: QueuedSweeperDeps, opts: QueuedSweeperOptions = {}): QueuedSweeper {
  const ttlMs = opts.ttlMs ?? DEFAULT_STALE_QUEUED_TTL_MS;
  return {
    async sweep(now = new Date()) {
      const olderThan = new Date(now.getTime() - ttlMs);
      const stale = await deps.listStaleQueued(olderThan);
      const results = await Promise.allSettled(
        stale.map((documentId) =>
          deps.failDocumentIfStale
            ? deps.failDocumentIfStale(documentId, olderThan)
            : deps.failDocument(documentId).then(() => true),
        ),
      );
      const rejected = results.filter((result) => result.status === 'rejected');
      if (rejected.length > 0) {
        throw new AggregateError(
          rejected.map((result) => (result as PromiseRejectedResult).reason),
          `${rejected.length} failDocument calls failed`,
        );
      }
      const failed = results.filter(
        (result): result is PromiseFulfilledResult<boolean> => result.status === 'fulfilled' && result.value,
      ).length;
      return { failed };
    },
  };
}
