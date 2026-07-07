import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  protectMock,
  redirectMock,
  nextMock,
  getClerkUserMock,
} = vi.hoisted(() => ({
  protectMock: vi.fn(),
  redirectMock: vi.fn(),
  nextMock: vi.fn(),
  getClerkUserMock: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: (auth: unknown, req: unknown) => unknown) => {
    // The returned function is what Next.js calls; we capture the
    // handler so tests can invoke it with a fake request + auth.
    return (req: unknown) => {
      const fakeAuth = {
        protect: protectMock,
      };
      return handler(fakeAuth, req);
    };
  },
  clerkClient: () =>
    Promise.resolve({
      users: { getUser: getClerkUserMock },
    }),
  createRouteMatcher: (routes: string[]) => {
    // Simplified path matcher. The proxy uses (.*) at the end of each
    // route; we recognise that pattern and treat it as a prefix.
    return (req: { nextUrl: { pathname: string } }) => {
      const path = req.nextUrl.pathname;
      return routes.some((r) => {
        if (r.endsWith('(.*)')) {
          const prefix = r.slice(0, -4);
          return path === prefix || path.startsWith(prefix + '/');
        }
        return path === r;
      });
    };
  },
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: () => {
      nextMock();
      return { type: 'next' };
    },
    redirect: (url: URL) => {
      redirectMock(url);
      return { type: 'redirect', url: url.toString() };
    },
  },
}));

vi.mock('@app/infrastructure/auth', async () => {
  const { clerkMiddleware, createRouteMatcher, clerkClient } = await import('@clerk/nextjs/server');
  const { NextResponse } = await import('next/server');

  const isPublicRoute = createRouteMatcher([
    '/',
    '/sign-in(.*)',
    '/sign-up(.*)',
    '/icon',
    '/apple-icon',
    '/opengraph-image',
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
    sessionClaims: unknown,
  ): Promise<'admin' | 'user'> {
    if (sessionClaims && typeof sessionClaims === 'object') {
      const claims = sessionClaims as
        | { metadata?: { role?: unknown } }
        | undefined;
      const fromClaims = claims?.metadata?.role;
      if (fromClaims === 'admin' || fromClaims === 'user') {
        return fromClaims;
      }
    }
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      const role = (user.publicMetadata as { role?: unknown } | null)?.role;
      if (role === 'admin' || role === 'user') return role;
    } catch (err) {
      console.error('proxy: failed to read user from Clerk', err);
    }
    return 'user';
  }

  return {
    createAuthAdapter: () => ({
      middleware: clerkMiddleware(async (auth, req) => {
        if (isPublicRoute(req)) return NextResponse.next();
        if (isProtectedRoute(req)) {
          const { userId, sessionClaims } = await auth.protect();
          if (isAdminRoute(req)) {
            const role = await resolveRole(userId, sessionClaims);
            if (role !== 'admin') {
              return NextResponse.redirect(new URL('/chat', (req as { url: string }).url));
            }
          }
          return NextResponse.next();
        }
        if ((req as { nextUrl: { pathname: string } }).nextUrl.pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return NextResponse.next();
      }),
      getAppSession: vi.fn(),
      requireAdmin: vi.fn(),
      requireSession: vi.fn(),
    }),
  };
});

import * as proxy from './proxy';
const proxyHandler = proxy.default as unknown as (req: { nextUrl: { pathname: string; href: string }; url: string }) => Promise<{ type: string; url?: string }> | { type: string; url?: string };

beforeEach(() => {
  protectMock.mockReset();
  redirectMock.mockReset();
  nextMock.mockReset();
  getClerkUserMock.mockReset();
  // Default: Clerk user lookup returns no role.
  getClerkUserMock.mockResolvedValue({ publicMetadata: {} });
});

function makeReq(pathname: string) {
  return {
    nextUrl: { pathname, href: `http://x${pathname}` },
    url: `http://x${pathname}`,
  };
}

function makeAuth(userId: string | null, role: string | null) {
  return {
    userId,
    sessionClaims: { metadata: { role } },
  };
}

describe('proxy.ts (auth adapter)', () => {
  it('passes public routes through', () => {
    proxyHandler(makeReq('/'));
    expect(protectMock).not.toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalled();
  });

  it('protects /chat and requires a signed-in user', async () => {
    protectMock.mockResolvedValue(makeAuth(null, null));
    await proxyHandler(makeReq('/chat'));
    expect(protectMock).toHaveBeenCalled();
  });

  it('redirects non-admin to /chat on /admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_1', 'user'));
    const result = await proxyHandler(makeReq('/admin'));
    expect(redirectMock).toHaveBeenCalled();
    expect(redirectMock.mock.calls[0]?.[0].toString()).toContain('/chat');
    expect(result.type).toBe('redirect');
  });

  it('lets admin through on /admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_admin', 'admin'));
    await proxyHandler(makeReq('/admin'));
    expect(redirectMock).not.toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalled();
  });

  it('redirects non-admin on /api/admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_1', 'user'));
    await proxyHandler(makeReq('/api/admin/users'));
    expect(redirectMock).toHaveBeenCalled();
  });

  it('lets admin through on /api/admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_admin', 'admin'));
    await proxyHandler(makeReq('/api/admin/users'));
    expect(nextMock).toHaveBeenCalled();
  });

  it('falls back to Clerk publicMetadata when JWT has no role', async () => {
    protectMock.mockResolvedValue(makeAuth('user_admin', null));
    getClerkUserMock.mockResolvedValue({
      publicMetadata: { role: 'admin' },
    });
    await proxyHandler(makeReq('/admin'));
    expect(redirectMock).not.toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalled();
  });

  it('redirects to /chat when fallback Clerk user is not admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_1', null));
    getClerkUserMock.mockResolvedValue({
      publicMetadata: { role: 'user' },
    });
    await proxyHandler(makeReq('/admin'));
    expect(redirectMock).toHaveBeenCalled();
  });
});
