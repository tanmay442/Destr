export function createTtlCache<V>(ttlMs: number, maxEntries: number) {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: V): void {
      if (entries.size >= maxEntries) {
        const now = Date.now();
        for (const [entryKey, entry] of entries) {
          if (entry.expiresAt <= now) entries.delete(entryKey);
        }
        while (entries.size >= maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    remove(key: string): void {
      entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
