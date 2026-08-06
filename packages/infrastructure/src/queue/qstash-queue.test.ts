import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createQstashQueue, resolveIngestWorkerUrl } from './qstash-queue';
import { createQueuedSweeper } from './queued-sweeper';

const publishJSONMock = vi.hoisted(() => vi.fn());

vi.mock('@upstash/qstash', () => ({
  Client: vi.fn().mockImplementation(function () {
    return { publishJSON: publishJSONMock };
  }),
}));

function setNodeEnv(env: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe('resolveIngestWorkerUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    publishJSONMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('prefers the explicit QSTASH_INGEST_WORKER_URL and trims trailing slashes', () => {
    process.env.QSTASH_INGEST_WORKER_URL = 'https://worker.example.com/';
    expect(resolveIngestWorkerUrl()).toBe('https://worker.example.com');
  });

  it('falls back to NEXT_PUBLIC_APP_URL origin then VERCEL_URL', () => {
    delete process.env.QSTASH_INGEST_WORKER_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/dashboard';
    expect(resolveIngestWorkerUrl()).toBe('https://app.example.com');
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = 'app.vercel.app';
    expect(resolveIngestWorkerUrl()).toBe('https://app.vercel.app');
  });

  it('refuses localhost URLs: warns in dev and returns empty', () => {
    delete process.env.QSTASH_INGEST_WORKER_URL;
    setNodeEnv('development');
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveIngestWorkerUrl()).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refusing worker URL'));
    warn.mockRestore();
  });

  it('refuses localhost URLs: throws in production', () => {
    delete process.env.QSTASH_INGEST_WORKER_URL;
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3000';
    expect(() => resolveIngestWorkerUrl()).toThrow(/Refusing worker URL/);
  });
});

describe('createQstashQueue', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    publishJSONMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('publishes to the worker URL with retries and the configured DLQ', async () => {
    process.env.QSTASH_TOKEN = 'test-token';
    process.env.QSTASH_INGEST_WORKER_URL = 'https://worker.example.com';
    process.env.QSTASH_DLQ_URL = 'https://dlq.example.com';
    publishJSONMock.mockResolvedValue({ messageId: 'm1' });

    const queue = createQstashQueue();
    await queue.enqueue({ documentId: 42 });

    expect(publishJSONMock).toHaveBeenCalledWith({
      url: 'https://worker.example.com/api/admin/ingest-worker',
      body: { documentId: 42 },
      retries: 3,
      dlq: 'https://dlq.example.com',
    });
  });

  it('warns loudly when no DLQ or failure callback is configured', async () => {
    process.env.QSTASH_TOKEN = 'test-token';
    process.env.QSTASH_INGEST_WORKER_URL = 'https://worker.example.com';
    delete process.env.QSTASH_DLQ_URL;
    delete process.env.QSTASH_FAILURE_CALLBACK_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createQstashQueue();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without QSTASH_DLQ_URL'));
    warn.mockRestore();
  });

  it('wraps publish failures with document context', async () => {
    process.env.QSTASH_TOKEN = 'test-token';
    process.env.QSTASH_INGEST_WORKER_URL = 'https://worker.example.com';
    process.env.QSTASH_DLQ_URL = 'https://dlq.example.com';
    publishJSONMock.mockRejectedValue(new Error('boom'));

    const queue = createQstashQueue();
    await expect(queue.enqueue({ documentId: 7 })).rejects.toThrow('QStash publish failed for document 7: boom');
  });

  it('fails enqueue when no worker URL can be resolved', async () => {
    process.env.QSTASH_TOKEN = 'test-token';
    delete process.env.QSTASH_INGEST_WORKER_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    setNodeEnv('test');

    const queue = createQstashQueue();
    await expect(queue.enqueue({ documentId: 1 })).rejects.toThrow(/QSTASH_INGEST_WORKER_URL/);
  });
});

describe('createQueuedSweeper', () => {
  it('marks stale queued documents failed past the TTL', async () => {
    const failed: number[] = [];
    const listStaleQueued = vi.fn().mockResolvedValue([1, 2, 3]);
    const failDocument = vi.fn().mockImplementation(async (id: number) => {
      failed.push(id);
    });
    const sweeper = createQueuedSweeper({ listStaleQueued, failDocument }, { ttlMs: 60_000 });

    const result = await sweeper.sweep(new Date('2026-01-01T00:10:00Z'));

    expect(listStaleQueued).toHaveBeenCalledWith(new Date('2026-01-01T00:09:00Z'));
    expect(failed).toEqual([1, 2, 3]);
    expect(result).toEqual({ failed: 3 });
  });

  it('uses a default TTL when none is provided', async () => {
    const listStaleQueued = vi.fn().mockResolvedValue([]);
    const sweeper = createQueuedSweeper({ listStaleQueued, failDocument: vi.fn() });
    await sweeper.sweep(new Date('2026-01-01T00:00:00Z'));
    const calls = listStaleQueued.mock.calls[0] ?? [];
    const calledWith = calls[0] as Date;
    expect(new Date('2026-01-01T00:00:00Z').getTime() - calledWith.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
