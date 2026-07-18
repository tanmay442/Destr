import { createHash } from 'node:crypto';

/**
 * Stable cache key for a query-keyed answer (Session 10).
 *
 * The key MUST be stable across repeated identical questions and MUST encode the
 * embedding + chat models, because a model swap silently changes the answer.
 * Normalisation deliberately trims, lowercases, and collapses whitespace so that
 * `"What is the  policy?"` and `"what is the policy ?"` collide to the same key.
 *
 * `embeddingModel` / `chatModel` are resolved by the caller (the route pins the
 * same ids the pipeline uses; see `infrastructure/src/llm`).
 *
 * HARD INVARIANT — retrieval is global, not user-scoped: the key deliberately
 * omits any user id and any document-version component. The chat route's
 * retrieval (`searchChunks`) returns the same corpus-wide results for every
 * user, so a global answer cache is safe. If per-user document visibility is
 * ever introduced, this function MUST be updated to include a user id and a
 * corpus-version / doc-set hash, and `AnswerCache` MUST gain an `invalidate()`
 * port to drop stale answers on document add/update/delete — otherwise the
 * cache will silently serve user-A's answer to user-B and serve stale answers
 * for the full TTL.
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
