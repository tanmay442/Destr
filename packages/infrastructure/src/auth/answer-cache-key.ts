import { createHash } from 'node:crypto';

/**
 * Stable SHA-256 cache key for a query-keyed answer. Normalizes the query
 * (trim, lowercase, collapse whitespace) and encodes embedding + chat model
 * ids so model swaps invalidate the cache.
 *
 * Key is deliberately user-scoped-free: retrieval is corpus-wide, so a global
 * answer cache is safe. If per-user document visibility is ever introduced,
 * this MUST be updated to include a user id.
 */
export function answerCacheKey(
  query: string,
  opts: { embeddingModel: string; chatModel: string },
): string {
  const normalised = query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .trim();
  const payload = `${normalised}::${opts.embeddingModel}::${opts.chatModel}`;
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `rag:answer:${hash}`;
}
