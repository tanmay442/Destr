import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenError } from '@app/domain';

const mocks = vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  return {
    protectMock: vi.fn(),
    authMock: vi.fn(),
    currentUserMock: vi.fn(),
    updateMetadataMock: vi.fn(),
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    insertMock: vi.fn(),
  };
});

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: (auth: unknown, req: unknown) => unknown) => {
    return (req: unknown) => handler({ protect: mocks.protectMock }, req);
  },
  createRouteMatcher: (routes: string[]) => {
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
  auth: () => mocks.authMock(),
  currentUser: () => mocks.currentUserMock(),
  clerkClient: () => Promise.resolve({ users: { updateUserMetadata: mocks.updateMetadataMock, getUser: vi.fn() } }),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: () => ({ type: 'next' }),
    redirect: (url: URL) => ({ type: 'redirect', url: url.toString() }),
    json: (body: unknown, init?: { status?: number }) => ({ type: 'json', body, status: init?.status ?? 200 }),
  },
}));

vi.mock('../db/client', () => ({
  db: {
    query: { users: { findFirst: mocks.findFirstMock } },
    update: (...args: unknown[]) => mocks.updateMock(...args),
    insert: (...args: unknown[]) => mocks.insertMock(...args),
  },
}));

import { resolveRole, createClerkAdapter, getAppSession, requireAdmin } from './clerk-adapter';
import { clerkSessionStore, syncClerkUserRole } from './clerk-session';

function userRow(role: 'admin' | 'user') {
  return {
    clerkUserId: 'user_x',
    email: 'e@example.com',
    name: null,
    imageUrl: null,
    role,
    lastSeenAt: null,
    createdAt: new Date(),
  };
}

function clerkUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_x',
    emailAddresses: [
      { id: 'email_a', emailAddress: 'primary@example.com', verification: { status: 'verified' } },
      { id: 'email_b', emailAddress: 'secondary@example.com', verification: { status: 'verified' } },
    ],
    primaryEmailAddressId: 'email_a',
    fullName: 'Test User',
    firstName: 'Test',
    username: null,
    imageUrl: null,
    ...overrides,
  };
}

function makeReq(pathname: string): { nextUrl: { pathname: string }; url: string } {
  return {
    nextUrl: { pathname },
    url: `http://x${pathname}`,
  };
}

type FakeReq = ReturnType<typeof makeReq>;
type MiddlewareResult = { type: string; status?: number; url?: string };

let middleware: (req: FakeReq) => Promise<MiddlewareResult>;

beforeEach(() => {
  mocks.protectMock.mockReset();
  mocks.authMock.mockReset();
  mocks.currentUserMock.mockReset();
  mocks.updateMetadataMock.mockReset();
  mocks.findFirstMock.mockReset();
  mocks.updateMock.mockReset();
  mocks.insertMock.mockReset();
  mocks.updateMetadataMock.mockResolvedValue(undefined);
  mocks.updateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
  mocks.insertMock.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([userRow('admin')]),
      }),
    }),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  middleware = createClerkAdapter().middleware as unknown as (req: FakeReq) => Promise<MiddlewareResult>;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveRole (DB-first)', () => {
  it('promotes immediately when the DB says admin despite user claims', async () => {
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    const role = await resolveRole('user_1', { metadata: { role: 'user' } });
    expect(role).toBe('admin');
  });

  it('demotes immediately when the DB says user despite admin claims', async () => {
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const role = await resolveRole('user_2', { metadata: { role: 'admin' } });
    expect(role).toBe('user');
  });

  it('falls back to claims only when the DB has no row', async () => {
    mocks.findFirstMock.mockResolvedValue(null);
    const role = await resolveRole('user_3', { metadata: { role: 'admin' } });
    expect(role).toBe('admin');
  });

  it('admits a verified admin email when the DB has no row', async () => {
    mocks.findFirstMock.mockResolvedValue(null);
    const role = await resolveRole('user_4', null, 'admin@example.com', true);
    expect(role).toBe('admin');
  });

  it('does not admit an unverified admin email', async () => {
    mocks.findFirstMock.mockResolvedValue(null);
    const role = await resolveRole('user_5', null, 'admin@example.com', false);
    expect(role).toBe('user');
  });

  it('returns user when nothing matches', async () => {
    mocks.findFirstMock.mockResolvedValue(null);
    const role = await resolveRole('user_6', null, 'user@example.com', true);
    expect(role).toBe('user');
  });
});

describe('middleware role resolution', () => {
  it('lets a promoted admin through /api/admin despite user claims', async () => {
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_mw_1',
      sessionClaims: { metadata: { role: 'user' } },
    });
    const result = await middleware(makeReq('/api/admin/users'));
    expect(result.type).toBe('next');
  });

  it('blocks a demoted admin on /api/admin despite admin claims', async () => {
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_mw_2',
      sessionClaims: { metadata: { role: 'admin' } },
    });
    const result = await middleware(makeReq('/api/admin/users'));
    expect(result.type).toBe('json');
    expect((result as { status?: number }).status).toBe(403);
  });

  it('consults the DB once within the TTL and re-queries after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_ttl',
      sessionClaims: { metadata: { role: 'user' } },
    });
    await middleware(makeReq('/api/admin/users'));
    await middleware(makeReq('/api/admin/users'));
    expect(mocks.findFirstMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await middleware(makeReq('/api/admin/users'));
    expect(mocks.findFirstMock).toHaveBeenCalledTimes(2);
  });

  it('applies a demotion as soon as the cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_ttl_2',
      sessionClaims: { metadata: { role: 'admin' } },
    });
    const allowed = await middleware(makeReq('/api/admin/users'));
    expect(allowed.type).toBe('next');
    vi.advanceTimersByTime(30_001);
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const blocked = await middleware(makeReq('/api/admin/users'));
    expect(blocked.type).toBe('json');
    expect((blocked as { status?: number }).status).toBe(403);
  });

  it('syncClerkUserRole invalidates the middleware role cache immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_sync_inv',
      sessionClaims: { metadata: { role: 'admin' } },
    });
    const allowed = await middleware(makeReq('/api/admin/users'));
    expect(allowed.type).toBe('next');
    await syncClerkUserRole('user_sync_inv', 'user');
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const blocked = await middleware(makeReq('/api/admin/users'));
    expect(blocked.type).toBe('json');
    expect((blocked as { status?: number }).status).toBe(403);
  });

  it('getAppSession promotion invalidates the cached role immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    mocks.protectMock.mockResolvedValue({
      userId: 'user_promo_inv',
      sessionClaims: { metadata: { role: 'user' } },
    });
    const blocked = await middleware(makeReq('/api/admin/users'));
    expect(blocked.type).toBe('json');
    mocks.authMock.mockResolvedValue({ userId: 'user_promo_inv' });
    mocks.currentUserMock.mockResolvedValue(
      clerkUser({
        id: 'user_promo_inv',
        emailAddresses: [
          { id: 'email_a', emailAddress: 'admin@example.com', verification: { status: 'verified' } },
        ],
      }),
    );
    const session = await getAppSession();
    expect(session?.user.role).toBe('admin');
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    const allowed = await middleware(makeReq('/api/admin/users'));
    expect(allowed.type).toBe('next');
  });

  it('warns in dev when an unmatched /api route silently 401s', async () => {
    mocks.protectMock.mockResolvedValue({
      userId: 'user_mw_3',
      sessionClaims: { metadata: { role: 'admin' } },
    });
    const result = await middleware(makeReq('/api/unknown-route'));
    expect(result.type).toBe('json');
    expect((result as { status?: number }).status).toBe(401);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unmatched API route /api/unknown-route'),
    );
  });
});

describe('getAppSession', () => {
  it('returns null when signed out', async () => {
    mocks.authMock.mockResolvedValue({ userId: null });
    expect(await getAppSession()).toBeNull();
  });

  it('prefers the primary email and reports the DB role', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_s1' });
    mocks.currentUserMock.mockResolvedValue(clerkUser({ id: 'user_s1' }));
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const session = await getAppSession();
    expect(session?.user.email).toBe('primary@example.com');
    expect(session?.user.role).toBe('user');
  });

  it('promotes a verified admin email and writes the role back to Clerk', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_s2' });
    mocks.currentUserMock.mockResolvedValue(
      clerkUser({
        id: 'user_s2',
        emailAddresses: [
          { id: 'email_a', emailAddress: 'admin@example.com', verification: { status: 'verified' } },
        ],
      }),
    );
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const session = await getAppSession();
    expect(session?.user.role).toBe('admin');
    expect(mocks.updateMetadataMock).toHaveBeenCalledWith('user_s2', {
      publicMetadata: { role: 'admin' },
    });
  });
});

describe('requireAdmin', () => {
  it('throws for a non-admin session', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_s3' });
    mocks.currentUserMock.mockResolvedValue(clerkUser({ id: 'user_s3' }));
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    await expect(requireAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns the session for an admin', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_s4' });
    mocks.currentUserMock.mockResolvedValue(clerkUser({ id: 'user_s4' }));
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    const session = await requireAdmin();
    expect(session.user.role).toBe('admin');
  });
});

describe('clerkSessionStore', () => {
  it('resolves the role from the DB row', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_r1' });
    mocks.currentUserMock.mockResolvedValue(clerkUser({ id: 'user_r1' }));
    mocks.findFirstMock.mockResolvedValue(userRow('admin'));
    const session = await clerkSessionStore.getSession();
    expect(session?.user.role).toBe('admin');
  });

  it('promotes a verified admin email and uses the primary email', async () => {
    mocks.authMock.mockResolvedValue({ userId: 'user_r2' });
    mocks.currentUserMock.mockResolvedValue(
      clerkUser({
        id: 'user_r2',
        emailAddresses: [
          { id: 'email_a', emailAddress: 'admin@example.com', verification: { status: 'verified' } },
          { id: 'email_b', emailAddress: 'secondary@example.com', verification: { status: 'verified' } },
        ],
        primaryEmailAddressId: 'email_a',
      }),
    );
    mocks.findFirstMock.mockResolvedValue(userRow('user'));
    const session = await clerkSessionStore.getSession();
    expect(session?.user.role).toBe('admin');
    expect(session?.user.email).toBe('admin@example.com');
  });

  it('returns null when signed out', async () => {
    mocks.authMock.mockResolvedValue({ userId: null });
    expect(await clerkSessionStore.getSession()).toBeNull();
  });
});