export type ProviderKey = string;

export interface ProviderRegistry<T> {
  register(key: ProviderKey, factory: T): void;
  get(key: ProviderKey): T | undefined;
}

export function createProviderRegistry<T>(): ProviderRegistry<T> {
  const providers = new Map<ProviderKey, T>();
  return {
    register(key, factory) {
      if (providers.has(key)) {
        console.warn(`[registry] provider "${key}" is already registered; the last registration wins.`);
      }
      providers.set(key, factory);
    },
    get(key) {
      return providers.get(key);
    },
  };
}
