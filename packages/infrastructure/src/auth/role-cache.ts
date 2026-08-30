import { createTtlCache } from '../cache/ttl-cache';

export type CachedRole = 'admin' | 'user';

const ROLE_TTL_MS = 30_000;
const roleCache = createTtlCache<CachedRole>(ROLE_TTL_MS, 2_000);
const pendingRoleResolves = new Map<string, Promise<CachedRole>>();

export function invalidateRoleCache(clerkUserId: string): void {
  roleCache.remove(clerkUserId);
  pendingRoleResolves.delete(clerkUserId);
}

export function resolveRoleCached(
  userId: string,
  resolve: () => Promise<CachedRole>,
): Promise<CachedRole> {
  const cached = roleCache.get(userId);
  if (cached) return Promise.resolve(cached);
  const pending = pendingRoleResolves.get(userId);
  if (pending) return pending;
  const promise = resolve()
    .then((role) => {
      roleCache.set(userId, role);
      pendingRoleResolves.delete(userId);
      return role;
    })
    .catch((error: unknown) => {
      pendingRoleResolves.delete(userId);
      throw error;
    });
  pendingRoleResolves.set(userId, promise);
  return promise;
}
