// Read-only SSR session; does NOT upsert, but promotes admin-email users so the
// SSR role stays consistent with the API role resolved in clerk-adapter.ts.
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { SessionStore } from '@app/domain';
import { isVerifiedAdminEmail } from './clerk-shared';

const USER_TTL_MS = 30_000;
const userCache = new Map<string, { user: Awaited<ReturnType<typeof currentUser>>; expiresAt: number }>();

async function getCurrentUserCached(userId: string) {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  const user = await currentUser();
  if (user) userCache.set(userId, { user, expiresAt: Date.now() + USER_TTL_MS });
  return user;
}

export const clerkSessionStore: SessionStore = {
  async getSession() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await getCurrentUserCached(userId);
    if (!user) return null;
    const local = await db.query.users.findFirst({ where: eq(users.clerkUserId, userId) });
    const email = user.emailAddresses[0]?.emailAddress ?? '';
    const localRole = (local?.role as 'admin' | 'user') ?? 'user';
    const verifiedAdmin = Boolean(isVerifiedAdminEmail(user.emailAddresses));
    const role: 'admin' | 'user' = localRole === 'admin' || verifiedAdmin ? 'admin' : 'user';
    return {
      user: {
        id: userId,
        email,
        name: user.fullName ?? user.firstName ?? user.username ?? 'User',
        imageUrl: user.imageUrl ?? null,
        role,
      },
    };
  },
};

export { clerkClient };
