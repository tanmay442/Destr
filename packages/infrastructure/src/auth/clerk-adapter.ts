import {
  auth,
  clerkClient,
  clerkMiddleware,
  createRouteMatcher,
  currentUser,
} from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { ForbiddenError, UnauthorizedError } from '@app/domain';
import { db } from '../db/client';
import { users } from '../db/schema';
import { userRepo } from '../db/repositories';
import { isAdminEmail, isVerifiedAdminEmail } from './clerk-shared';
import type { AuthAdapter } from './auth-factory';

export type AppRole = 'admin' | 'user';

export interface AppSessionFull {
  user: {
    id: string;
    email: string;
    name: string;
    imageUrl: string | null;
    role: AppRole;
  };
}

async function findUserByClerkId(clerkUserId: string) {
  const row = await db.query.users.findFirst({ where: eq(users.clerkUserId, clerkUserId) });
  return (row as { clerkUserId: string; email: string; name: string | null; imageUrl: string | null; role: string; lastSeenAt: Date | null; createdAt: Date } | undefined) ?? null;
}

async function touchLastSeen(clerkUserId: string): Promise<void> {
  // Avoids an extra SELECT: only updates when last_seen_at is NULL or >60s stale.
  await db.update(users).set({ lastSeenAt: sql`now()` }).where(
    and(
      eq(users.clerkUserId, clerkUserId),
      or(
        isNull(users.lastSeenAt),
        sql`${users.lastSeenAt} < now() - interval '60 seconds'`,
      ),
    ),
  );
}

function parseClerkRole(value: unknown): AppRole | null {
  if (value === 'admin' || value === 'user') return value;
  return null;
}

export async function getAppSession(): Promise<AppSessionFull | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const user = await currentUser();
  if (!user) return null;
  const email = user.emailAddresses[0]?.emailAddress ?? '';
  const verifiedAdminEmail = isVerifiedAdminEmail(user.emailAddresses);
  let local = await findUserByClerkId(userId);
  if (!local) {
    const clerkRole = parseClerkRole(
      (user.publicMetadata as { role?: unknown } | null)?.role,
    );
    local = await userRepo.upsertFromClerk({
      clerkUserId: userId,
      email,
      name: user.fullName ?? user.firstName ?? user.username ?? null,
      imageUrl: user.imageUrl ?? null,
      role: clerkRole ?? (verifiedAdminEmail ? 'admin' : 'user'),
    });
  } else if (verifiedAdminEmail && local.role !== 'admin') {
    local = await userRepo.upsertFromClerk({
      clerkUserId: userId,
      email,
      name: local.name,
      imageUrl: local.imageUrl,
      role: 'admin',
    });
    const client = await clerkClient();
    client.users.updateUserMetadata(userId, { publicMetadata: { role: 'admin' } }).catch(() => {});
  }
  void touchLastSeen(userId).catch(() => {});
  return {
    user: {
      id: userId,
      email,
      name: local.name ?? user.fullName ?? user.firstName ?? 'User',
      imageUrl: local.imageUrl ?? user.imageUrl ?? null,
      role: local.role as AppRole,
    },
  };
}

export async function requireAdmin(): Promise<AppSessionFull> {
  const session = await getAppSession();
  if (!session) throw new UnauthorizedError('Not signed in');
  if (session.user.role !== 'admin') throw new ForbiddenError('Admin role required');
  return session;
}

export async function requireSession(): Promise<AppSessionFull> {
  const session = await getAppSession();
  if (!session) throw new UnauthorizedError('Not signed in');
  return session;
}

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/icon',
  '/apple-icon',
  '/opengraph-image',
  // QStash-signed worker: gated solely by its own signature verification.
  '/api/admin/ingest-worker(.*)',
]);

const isProtectedRoute = createRouteMatcher([
  '/chat(.*)',
  '/admin(.*)',
  '/api/chat(.*)',
  '/api/admin(.*)',
]);

const isAdminRoute = createRouteMatcher([
  '/admin(.*)',
  '/api/admin(.*)',
]);

async function resolveRole(
  userId: string,
  sessionClaims: Record<string, unknown> | null | undefined,
  email?: string,
  emailVerified?: boolean,
): Promise<'admin' | 'user'> {
  const claims = sessionClaims as { metadata?: { role?: unknown } } | undefined;
  const fromClaims = claims?.metadata?.role;
  if (fromClaims === 'admin' || fromClaims === 'user') return fromClaims;
  const local = await findUserByClerkId(userId);
  if (local?.role === 'admin') return 'admin';
  if (email && emailVerified && isAdminEmail(email)) return 'admin';
  return 'user';
}

function createMiddleware(): AuthAdapter['middleware'] {
  return clerkMiddleware(async (auth, req) => {
    if (isPublicRoute(req)) return NextResponse.next();
    if (isProtectedRoute(req)) {
      const { userId, sessionClaims } = await auth.protect();
      if (isAdminRoute(req)) {
        const claims = sessionClaims as { email?: unknown; email_verified?: unknown } | undefined;
        const email = typeof claims?.email === 'string' ? claims.email : undefined;
        const verified = claims?.email_verified === true;
        const role = await resolveRole(userId, sessionClaims, email, verified);
        if (role !== 'admin') {
          if (req.nextUrl.pathname.startsWith('/api/')) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          return NextResponse.redirect(new URL('/chat', req.url));
        }
      }
      return NextResponse.next();
    }
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }) as unknown as AuthAdapter['middleware'];
}

export function createClerkAdapter(): AuthAdapter {
  return {
    middleware: createMiddleware() as unknown as AuthAdapter['middleware'],
    getAppSession,
    requireAdmin,
    requireSession,
    clerkClient: async () => clerkClient(),
  };
}
