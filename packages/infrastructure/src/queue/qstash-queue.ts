import { Client } from '@upstash/qstash';
import type { IngestQueue } from '@app/domain';

/**
 * Resolves the public ingest-worker base URL.
 * Prefers an explicit QSTASH_INGEST_WORKER_URL override, then falls back to
 * NEXT_PUBLIC_APP_URL / VERCEL_URL so a Vercel deploy never needs a separate
 * (and easily-forgotten) env var to use the async ingest path.
 */
export function resolveIngestWorkerUrl(): string {
  const explicit = process.env.QSTASH_INGEST_WORKER_URL;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl && appUrl.trim()) {
    try {
      return new URL(appUrl).origin;
    } catch {
      /* fall through */
    }
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim()) {
    return `https://${vercelUrl.trim().replace(/^https?:\/\//, '')}`;
  }
  return '';
}

/** QStash queue: publishes JSON to the ingest-worker route, retries on non-2xx. Needs QSTASH_TOKEN + worker URL. */
export function createQstashQueue(): IngestQueue {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN is not set.');
  const client = new Client({ token });
  const baseUrl = resolveIngestWorkerUrl();
  const dlqUrl = process.env.QSTASH_DLQ_URL ?? '';
  return {
    async enqueue({ documentId }) {
      if (!baseUrl) throw new Error('QSTASH_INGEST_WORKER_URL is not set.');
      await client.publishJSON({
        url: `${baseUrl}/api/admin/ingest-worker`,
        body: { documentId },
        retries: 3,
        ...(dlqUrl ? { dlq: dlqUrl } : {}),
      });
    },
    isNoOp() {
      return false;
    },
  };
}
