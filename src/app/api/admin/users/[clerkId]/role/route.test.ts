import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { requireAdminMock, setUserRoleMock, requireAdminRouteMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const setUserRoleMock = vi.fn();
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return { ok: true as const, session, comp: { setUserRole: setUserRoleMock } };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  return { requireAdminMock, setUserRoleMock, requireAdminRouteMock };
});

vi.mock('@/composition', async () => {
  const { ForbiddenError } = await import('@app/domain');
  const { respond } = await import('@/lib/http');
  return {
    requireAdmin: requireAdminMock,
    requireAdminRoute: requireAdminRouteMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    respond,
    getComposition: () => ({ setUserRole: setUserRoleMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  setUserRoleMock.mockReset();
});

function makeParams(clerkId: string) {
  return { params: Promise.resolve({ clerkId }) };
}

function makeReq(body: unknown) {
  return new Request('http://x/api/admin/users/u/role', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/users/[clerkId]/role', () => {
  it('returns 403 for non-admin', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.POST(makeReq({ role: 'admin' }), makeParams('user_1'));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown role with 400', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x', name: 'A', role: 'admin' },
    });
    const res = await route.POST(makeReq({ role: 'superuser' }), makeParams('user_1'));
    expect(res.status).toBe(400);
  });

  it('returns the updated user for a valid role', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x', name: 'A', role: 'admin' },
    });
    setUserRoleMock.mockResolvedValue(ok({
      clerkUserId: 'user_1',
      role: 'admin',
    }) as never);
    const res = await route.POST(makeReq({ role: 'admin' }), makeParams('user_1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { clerkUserId: 'user_1', role: 'admin' },
    });
  });

  it('returns 400 for invalid JSON', async () => {
    requireAdminMock.mockResolvedValue({});
    const req = new Request('http://x/api/admin/users/u/role', {
      method: 'POST',
      body: '{ not json',
    });
    const res = await route.POST(req, makeParams('user_1'));
    expect(res.status).toBe(400);
  });

  it('returns 200 when setting role to user', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x', name: 'A', role: 'admin' },
    });
    setUserRoleMock.mockResolvedValue(ok({
      clerkUserId: 'user_1',
      role: 'user',
    }) as never);
    const res = await route.POST(makeReq({ role: 'user' }), makeParams('user_1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { clerkUserId: 'user_1', role: 'user' },
    });
  });

  it('returns 400 for an empty/malformed clerkId', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x', name: 'A', role: 'admin' },
    });
    const res = await route.POST(makeReq({ role: 'admin' }), makeParams(''));
    expect(res.status).toBe(400);
  });
});
