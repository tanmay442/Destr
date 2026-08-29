import { currentUser } from '@clerk/nextjs/server';
import { createTtlCache } from '../cache/ttl-cache';

export { createTtlCache } from '../cache/ttl-cache';

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

export function isEmailVerified(
  emailAddresses: ClerkEmailAddress[] | undefined,
  emailAddress: string,
): boolean {
  if (!emailAddresses || !emailAddress) return false;
  const normalizedAddress = emailAddress.toLowerCase();
  return emailAddresses.some(
    (entry) => entry.emailAddress?.toLowerCase() === normalizedAddress && emailVerified(entry),
  );
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

const USER_TTL_MS = 30_000;
const userCache = createTtlCache<Awaited<ReturnType<typeof currentUser>>>(USER_TTL_MS, 1_000);

export async function getClerkUserCached(userId: string) {
  const cached = userCache.get(userId);
  if (cached) return cached;
  const user = await currentUser();
  if (user) userCache.set(userId, user);
  return user;
}
