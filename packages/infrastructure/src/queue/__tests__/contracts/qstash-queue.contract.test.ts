import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createQstashQueue } from '../../qstash-queue';
import { runIngestQueueContract } from './ingest-queue-contract';

const publishJSONMock = vi.hoisted(() => vi.fn());

vi.mock('@upstash/qstash', () => ({
  Client: vi.fn().mockImplementation(function () {
    return { publishJSON: publishJSONMock };
  }),
}));

describe('qstash queue contract', () => {
  beforeEach(() => {
    vi.stubEnv('QSTASH_TOKEN', 'test-token');
    vi.stubEnv('QSTASH_INGEST_WORKER_URL', 'https://worker.example.com');
    vi.stubEnv('QSTASH_DLQ_URL', 'https://dlq.example.com');
    vi.stubEnv('NODE_ENV', 'test');
    publishJSONMock.mockReset();
    publishJSONMock.mockResolvedValue({ messageId: 'm1' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  runIngestQueueContract(() => createQstashQueue(), { expectNoOp: false });

  it('publishes to the ingest worker with the document id and retries (request shape)', async () => {
    const queue = createQstashQueue();
    await queue.enqueue({ documentId: 42 });
    expect(publishJSONMock).toHaveBeenCalledWith({
      url: 'https://worker.example.com/api/admin/ingest-worker',
      body: { documentId: 42 },
      retries: 3,
      deduplicationId: 'document:42',
      dlq: 'https://dlq.example.com',
    });
  });
});
