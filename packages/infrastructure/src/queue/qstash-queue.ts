import { Client } from '@upstash/qstash';
import type { IngestQueue } from '@app/domain';

/** QStash queue: publishes JSON to the ingest-worker route, retries on non-2xx. Needs QSTASH_TOKEN + QSTASH_INGEST_WORKER_URL. */
export function createQstashQueue(): IngestQueue {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN is not set.');
  const client = new Client({ token });
  const baseUrl = process.env.QSTASH_INGEST_WORKER_URL ?? '';
  return {
    async enqueue({ documentId }) {
      if (!baseUrl) throw new Error('QSTASH_INGEST_WORKER_URL is not set.');
      await client.publishJSON({
        url: `${baseUrl}/api/admin/ingest-worker`,
        body: { documentId },
        retries: 3,
      });
    },
  };
}
