import { createHash } from 'node:crypto';

/**
 * Stable SHA-256 cache key for a query-keyed answer. Normalizes the query
 * (trim, lowercase, collapse whitespace) and encodes embedding + chat model
 * ids plus a config fingerprint so model swaps and retrieval/settings changes
 * invalidate the cache.
 *
 * The key is namespaced by `userId` when provided: retrieval is corpus-wide
 * but generated answers may embed user-specific data (tickets, personal
 * details), so cross-user serving is never safe. The caller must also refuse
 * to cache turns whose guardrails blocked the answer.
 */
export function answerCacheKey(
  query: string,
  opts: {
    embeddingModel: string;
    chatModel: string;
    userId?: string;
    fingerprint?: string;
  },
): string {
  const normalised = query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .trim();
  const payload = [
    normalised,
    opts.embeddingModel,
    opts.chatModel,
    opts.userId ?? '',
    opts.fingerprint ?? '',
  ].join('::');
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `rag:answer:${hash}`;
}
