// Read-only SSR session; does NOT upsert, but promotes admin-email users so the
// SSR role stays consistent with the API role resolved in clerk-adapter.ts.
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { SessionStore } from '@app/domain';
import { isAdminEmail } from './clerk-shared';

export const clerkSessionStore: SessionStore = {
  async getSession() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await currentUser();
    if (!user) return null;
    const local = await db.query.users.findFirst({ where: eq(users.clerkUserId, userId) });
    const email = user.emailAddresses[0]?.emailAddress ?? '';
    const localRole = (local?.role as 'admin' | 'user') ?? 'user';
    const role: 'admin' | 'user' = localRole === 'admin' || isAdminEmail(email) ? 'admin' : 'user';
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
