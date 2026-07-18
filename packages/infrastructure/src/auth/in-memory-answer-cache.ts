import type { AnswerCache } from '@app/domain';

const MAX_KEYS = 5_000;

export function createInMemoryAnswerCache(): AnswerCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();

  const sweep = () => {
    if (store.size <= MAX_KEYS) return;
    for (const k of store.keys()) {
      if (store.size <= MAX_KEYS) break;
      store.delete(k);
    }
  };

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    async set(key, answer, ttlSec) {
      store.delete(key);
      store.set(key, { value: answer, expiresAt: now() + ttlSec * 1000 });
      sweep();
    },
  };
}
