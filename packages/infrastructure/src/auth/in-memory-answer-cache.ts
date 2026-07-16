import type { AnswerCache } from '@app/domain';

/**
 * Process-local fallback used when Upstash Redis is not configured. Answers are
 * only cacheable within a single server instance and are lost on restart, so it
 * is not suitable for serverless multi-instance deployments — but it keeps the
 * cache toggle functional in local/dev and in tests.
 */
export function createInMemoryAnswerCache(): AnswerCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, answer, ttlSec) {
      store.set(key, { value: answer, expiresAt: now() + ttlSec * 1000 });
    },
  };
}
