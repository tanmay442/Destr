export interface QueuedSweeperDeps {
  listStaleQueued(olderThan: Date): Promise<number[]>;
  failDocument(documentId: number): Promise<void>;
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
      for (const documentId of stale) {
        await deps.failDocument(documentId);
      }
      return { failed: stale.length };
    },
  };
}
