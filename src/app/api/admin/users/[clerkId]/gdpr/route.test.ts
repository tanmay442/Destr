import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAdminMock, requireAdminRouteMock, getUserByClerkIdMock, purgeUserDataMock, anonymizeUserDataMock, logUserAuditMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const getUserByClerkIdMock = vi.fn();
  const purgeUserDataMock = vi.fn();
  const anonymizeUserDataMock = vi.fn();
  const logUserAuditMock = vi.fn();
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return {
        ok: true as const,
        session,
        comp: {
          getUserByClerkId: getUserByClerkIdMock,
          chatEventBatcher: { purgeUserData: purgeUserDataMock, anonymizeUserData: anonymizeUserDataMock },
          logUserAudit: logUserAuditMock,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  return { requireAdminMock, requireAdminRouteMock, getUserByClerkIdMock, purgeUserDataMock, anonymizeUserDataMock, logUserAuditMock };
});

vi.mock('@/composition', async () => {
  const { ForbiddenError } = await import('@app/domain');
  const { respond, respondResult } = await import('@/lib/http');
  return {
    requireAdmin: requireAdminMock,
    requireAdminRoute: requireAdminRouteMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    respond,
    respondResult,
    getComposition: () => ({}),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  getUserByClerkIdMock.mockReset();
  purgeUserDataMock.mockReset();
  anonymizeUserDataMock.mockReset();
  logUserAuditMock.mockReset();
  getUserByClerkIdMock.mockResolvedValue({ ok: true, value: { user: { clerkUserId: 'user_2', email: 'x@x.com', name: null, role: 'user' } } });
});

function makeParams(clerkId: string) {
  return { params: Promise.resolve({ clerkId }) };
}

function makeReq(action: string) {
  return new Request('http://x/api/admin/users/user_2/gdpr', { method: 'POST', body: JSON.stringify({ action }) });
}

const adminSession = { user: { id: 'admin-1', email: 'a@x.com', name: 'A', role: 'admin' } };

describe('POST /api/admin/users/[clerkId]/gdpr', () => {
  it('returns 403 for non-admin', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.POST(makeReq('purge'), makeParams('user_2'));
    expect(res.status).toBe(403);
  });

  it('rejects purging your own data', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'user_2', email: 'x@x.com', name: null, role: 'admin' } });
    const res = await route.POST(makeReq('purge'), makeParams('user_2'));
    expect(res.status).toBe(403);
    expect(purgeUserDataMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid clerkId', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    const res = await route.POST(makeReq('purge'), makeParams('not a valid!'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target user does not exist', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    getUserByClerkIdMock.mockResolvedValue({ ok: true, value: { user: null } });
    const res = await route.POST(makeReq('purge'), makeParams('ghost'));
    expect(res.status).toBe(404);
    expect(purgeUserDataMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid action', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    const res = await route.POST(makeReq('bogus'), makeParams('user_2'));
    expect(res.status).toBe(400);
  });

  it('purges data and audits the action', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    purgeUserDataMock.mockResolvedValue({ deletedCount: 3 });
    const res = await route.POST(makeReq('purge'), makeParams('user_2'));
    expect(res.status).toBe(200);
    expect(purgeUserDataMock).toHaveBeenCalledWith('user_2');
    expect(logUserAuditMock).toHaveBeenCalledWith({ action: 'gdpr_purge', actorId: 'admin-1', targetId: 'user_2' });
  });

  it('anonymizes data and audits the action', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    anonymizeUserDataMock.mockResolvedValue({ updatedCount: 2 });
    const res = await route.POST(makeReq('anonymize'), makeParams('user_2'));
    expect(res.status).toBe(200);
    expect(anonymizeUserDataMock).toHaveBeenCalledWith('user_2');
    expect(logUserAuditMock).toHaveBeenCalledWith({ action: 'gdpr_anonymize', actorId: 'admin-1', targetId: 'user_2' });
  });

  it('returns 502 when purge fails with an external error', async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    purgeUserDataMock.mockRejectedValue(new Error('db down'));
    const res = await route.POST(makeReq('purge'), makeParams('user_2'));
    expect(res.status).toBe(502);
  });
});