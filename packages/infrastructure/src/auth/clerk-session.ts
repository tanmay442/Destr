// Read-only session resolution for SSR. Reads the role from the DB
// users table but does NOT upsert or perform admin-email promotion
// (that is handled by getAppSession() in clerk-adapter.ts). Use
// getAppSession() when you need the full promotion/upsert path;
// use this store for lightweight SSR where the user is already
// known to exist in the DB.
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
