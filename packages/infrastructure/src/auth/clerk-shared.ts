import { currentUser } from '@clerk/nextjs/server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((e) => e && EMAIL_RE.test(e));

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

export interface ClerkEmailAddress {
  id?: string;
  emailAddress?: string;
  verification?: { status?: string } | Array<{ status?: string }> | null;
}

function emailVerified(email: ClerkEmailAddress | undefined): boolean {
  if (!email) return false;
  const v = email.verification;
  if (Array.isArray(v)) return v.some((x) => x?.status === 'verified');
  return v?.status === 'verified';
}

export function isVerifiedAdminEmail(
  emailAddresses: ClerkEmailAddress[] | undefined,
): string | null {
  if (!emailAddresses) return null;
  for (const e of emailAddresses) {
    if (e.emailAddress && emailVerified(e) && isAdminEmail(e.emailAddress)) {
      return e.emailAddress;
    }
  }
  return null;
}

export function primaryEmailAddress(
  emailAddresses: ClerkEmailAddress[] | undefined,
  primaryId: string | null | undefined,
): string {
  if (!emailAddresses || emailAddresses.length === 0) return '';
  const primary = primaryId
    ? emailAddresses.find((e) => e.id === primaryId)
    : undefined;
  return primary?.emailAddress ?? emailAddresses[0]?.emailAddress ?? '';
}

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
        for (const [k, entry] of entries) {
          if (entry.expiresAt <= now) entries.delete(k);
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

const USER_TTL_MS = 30_000;
const userCache = createTtlCache<Awaited<ReturnType<typeof currentUser>>>(USER_TTL_MS, 1_000);

export async function getClerkUserCached(userId: string) {
  const cached = userCache.get(userId);
  if (cached) return cached;
  const user = await currentUser();
  if (user) userCache.set(userId, user);
  return user;
}
