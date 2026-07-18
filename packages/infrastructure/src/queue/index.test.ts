import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Queue from './index';
import { createSyncQueue } from './sync-queue';

describe('Ingest queue factory dispatch', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the sync (no-op) queue when QSTASH_TOKEN is unset', async () => {
    delete process.env.QSTASH_TOKEN;
    const q = Queue.createIngestQueue();
    expect(q).not.toBeUndefined();
    expect(typeof q.enqueue).toBe('function');
    await expect(q.enqueue({ documentId: 1 })).resolves.toBeUndefined();
  });

  it('exposes the sync queue factory directly', async () => {
    const q = createSyncQueue();
    expect(typeof q.enqueue).toBe('function');
    await expect(q.enqueue({ documentId: 2 })).resolves.toBeUndefined();
  });

  it('reports isNoOp true when no inline ingest is wired (no-op queue)', () => {
    expect(createSyncQueue().isNoOp()).toBe(true);
  });

  it('reports isNoOp false when an inline ingest is wired (sync inline queue)', () => {
    const q = createSyncQueue({ ingest: async () => {} });
    expect(q.isNoOp()).toBe(false);
  });

  it('throws from the QStash adapter when QSTASH_TOKEN is set but the worker URL is missing', async () => {
    process.env.QSTASH_TOKEN = 'test-token';
    delete process.env.QSTASH_INGEST_WORKER_URL;
    const q = Queue.createIngestQueue();
    await expect(q.enqueue({ documentId: 3 })).rejects.toThrow(/QSTASH_INGEST_WORKER_URL/);
  });
});
