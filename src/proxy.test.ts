import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  protectMock,
  redirectMock,
  nextMock,
  jsonMock,
  ADMIN_EMAILS,
} = vi.hoisted(() => ({
  protectMock: vi.fn(),
  redirectMock: vi.fn(),
  nextMock: vi.fn(),
  jsonMock: vi.fn(),
  ADMIN_EMAILS: ['admin@example.com'],
}));

process.env.ADMIN_EMAILS = ADMIN_EMAILS.join(',');

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
      users: { getUser: vi.fn() },
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
    json: (body: unknown, init?: { status?: number }) => {
      jsonMock(body, init);
      return { type: 'json', body, status: init?.status ?? 200 };
    },
  },
}));

vi.mock('@app/infrastructure/auth', async () => {
  const { clerkMiddleware, createRouteMatcher } = await import('@clerk/nextjs/server');
  const { NextResponse } = await import('next/server');

  const isPublicRoute = createRouteMatcher([
    '/',
    '/sign-in(.*)',
    '/sign-up(.*)',
    '/icon',
    '/apple-icon',
    '/opengraph-image',
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
    sessionClaims: unknown,
  ): Promise<'admin' | 'user'> {
    const claims = sessionClaims as { metadata?: { role?: unknown }; email?: unknown } | undefined;
    const fromClaims = claims?.metadata?.role;
    if (fromClaims === 'admin' || fromClaims === 'user') return fromClaims;
    if (claims?.email && typeof claims.email === 'string' && ADMIN_EMAILS.includes(claims.email.toLowerCase())) {
      return 'admin';
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
              if ((req as { nextUrl: { pathname: string } }).nextUrl.pathname.startsWith('/api/')) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
              }
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
  jsonMock.mockReset();
});

function makeReq(pathname: string) {
  return {
    nextUrl: { pathname, href: `http://x${pathname}` },
    url: `http://x${pathname}`,
  };
}

function makeAuth(userId: string | null, role: string | null, email?: string) {
  return {
    userId,
    sessionClaims: { metadata: { role }, email },
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

  it('returns 403 JSON for non-admin on /api/admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_1', 'user'));
    const result = await proxyHandler(makeReq('/api/admin/users'));
    expect(redirectMock).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalled();
    expect(result.type).toBe('json');
    expect((result as { status?: number }).status).toBe(403);
  });

  it('excludes /api/admin/ingest-worker from auth (QStash-signed)', async () => {
    await proxyHandler(makeReq('/api/admin/ingest-worker'));
    expect(protectMock).not.toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalled();
  });

  it('lets admin through on /api/admin', async () => {
    protectMock.mockResolvedValue(makeAuth('user_admin', 'admin'));
    await proxyHandler(makeReq('/api/admin/users'));
    expect(nextMock).toHaveBeenCalled();
  });

  it('admits admin-email user to /admin even when JWT has no role', async () => {
    protectMock.mockResolvedValue(makeAuth('user_admin', null, 'admin@example.com'));
    await proxyHandler(makeReq('/admin'));
    expect(redirectMock).not.toHaveBeenCalled();
    expect(nextMock).toHaveBeenCalled();
  });

  it('redirects non-admin-email user on /admin when JWT has no role', async () => {
    protectMock.mockResolvedValue(makeAuth('user_1', null, 'user@example.com'));
    await proxyHandler(makeReq('/admin'));
    expect(redirectMock).toHaveBeenCalled();
  });
});
