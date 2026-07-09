// Read-only session for SSR. Reads role from the DB but does NOT upsert
// or promote admin-email (see getAppSession() in clerk-adapter.ts).
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { SessionStore } from '@app/domain';

export const clerkSessionStore: SessionStore = {
  async getSession() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await currentUser();
    if (!user) return null;
    const local = await db.query.users.findFirst({ where: eq(users.clerkUserId, userId) });
    const role = (local?.role as 'admin' | 'user') ?? 'user';
    return {
      user: {
        id: userId,
        email: user.emailAddresses[0]?.emailAddress ?? '',
        name: user.fullName ?? user.firstName ?? user.username ?? 'User',
        imageUrl: user.imageUrl ?? null,
        role,
      },
    };
  },
};

export { clerkClient };
