import { auth, clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { SessionStore } from '@app/domain';
import { getClerkUserCached, isVerifiedAdminEmail, primaryEmailAddress } from './clerk-shared';

export const clerkSessionStore: SessionStore = {
  async getSession() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await getClerkUserCached(userId);
    if (!user) return null;
    const local = await db.query.users.findFirst({ where: eq(users.clerkUserId, userId) });
    const email = primaryEmailAddress(user.emailAddresses, user.primaryEmailAddressId);
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

export async function syncClerkUserRole(clerkUserId: string, role: 'admin' | 'user'): Promise<void> {
  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(clerkUserId, { publicMetadata: { role } });
}

export { clerkClient };
