import { Client } from '@upstash/qstash';
import { logger, type IngestQueue } from '@app/domain';
import { registerIngestQueueProvider } from './ingest-queue-registry';

/**
 * Resolves the public ingest-worker base URL.
 * Prefers an explicit QSTASH_INGEST_WORKER_URL override, then falls back to
 * NEXT_PUBLIC_APP_URL / VERCEL_URL so a Vercel deploy never needs a separate
 * (and easily-forgotten) env var to use the async ingest path.
 */
export function resolveIngestWorkerUrl(): string {
  const explicit = process.env.QSTASH_INGEST_WORKER_URL;
  if (explicit && explicit.trim()) return normalizeWorkerUrl(explicit.trim());

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl && appUrl.trim()) {
    let origin = '';
    try {
      origin = new URL(appUrl).origin;
    } catch {
      origin = '';
    }
    if (origin) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn('[ingest-queue] QSTASH_INGEST_WORKER_URL is not set; falling back to NEXT_PUBLIC_APP_URL. Set the dedicated variable in production.');
      }
      return normalizeWorkerUrl(origin);
    }
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim()) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[ingest-queue] QSTASH_INGEST_WORKER_URL is not set; falling back to VERCEL_URL. Set the dedicated variable in production.');
    }
    return normalizeWorkerUrl(`https://${vercelUrl.trim().replace(/^https?:\/\//, '')}`);
  }
  return '';
}

/** Trim the trailing slash and refuse unreachable localhost worker URLs. */
function normalizeWorkerUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const message = `[ingest-queue] Refusing invalid worker URL: ${raw}`;
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    logger.warn(message);
    return '';
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    const message = `[ingest-queue] Refusing unsafe worker URL: ${raw}`;
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    logger.warn(message);
    return '';
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    const message =
      `[ingest-queue] Refusing worker URL ${raw}: QStash cannot reach a localhost address. ` +
      'Set QSTASH_INGEST_WORKER_URL to a publicly reachable URL.';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    logger.warn(message);
    return '';
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * QStash queue: publishes JSON to the ingest-worker route, retries on non-2xx.
 * Needs QSTASH_TOKEN + worker URL. Requires a DLQ or failure callback so failed
 * messages are never silently dropped after the retry budget is exhausted.
 */
export function createQstashQueue(): IngestQueue {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN is not set.');
  const client = new Client({ token });
  const baseUrl = resolveIngestWorkerUrl();
  const dlqUrl = process.env.QSTASH_DLQ_URL ?? '';
  const failureCallbackUrl = process.env.QSTASH_FAILURE_CALLBACK_URL ?? '';
  if (!baseUrl) {
    logger.warn('[ingest-queue] QSTASH_TOKEN is set but no ingest worker URL resolved; enqueues will fail. Set QSTASH_INGEST_WORKER_URL.');
  }
  if (!dlqUrl && !failureCallbackUrl) {
    logger.warn(
      '[ingest-queue] QStash is configured without QSTASH_DLQ_URL or QSTASH_FAILURE_CALLBACK_URL. ' +
        'After retries are exhausted, failed messages are silently dropped and documents stay queued.',
    );
  }
  return {
    async enqueue({ documentId, fileHash, attemptId }: { documentId: number; fileHash?: string; attemptId?: string }) {
      if (!baseUrl) throw new Error('QSTASH_INGEST_WORKER_URL is not set.');
      const deduplicationId = attemptId
        ? `document:${documentId}:attempt:${attemptId}`
        : fileHash
          ? `document:${documentId}:${fileHash}`
          : `document:${documentId}`;
      try {
        await client.publishJSON({
          url: `${baseUrl}/api/admin/ingest-worker`,
          body: { documentId, ...(fileHash ? { fileHash } : {}), ...(attemptId ? { attemptId } : {}) },
          retries: 3,
          deduplicationId,
          ...(dlqUrl ? { dlq: dlqUrl } : {}),
          ...(failureCallbackUrl ? { failureCallback: failureCallbackUrl } : {}),
        });
      } catch (e) {
        throw new Error(`QStash publish failed for document ${documentId}: ${(e as Error)?.message ?? String(e)}`, {
          cause: e,
        });
      }
    },
    isNoOp() {
      return false;
    },
  };
}

registerIngestQueueProvider('qstash', createQstashQueue);
