import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { listUsersMock, requireAdminGetMock } = vi.hoisted(() => {
  const listUsersMock = vi.fn(async () => state.result);
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { listUsers: listUsersMock },
      url: new URL(req.url),
    };
  });
  return { listUsersMock, requireAdminGetMock };
});

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminGet: requireAdminGetMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ users: [], total: 0 });
  listUsersMock.mockClear();
});

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://x/api/admin/users');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe('GET /api/admin/users', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('passes search and pagination to listUsers', async () => {
    await route.GET(makeReq({ search: 'alice', limit: '25', offset: '0' }));
    expect(listUsersMock).toHaveBeenCalledWith({ search: 'alice', limit: 25, offset: 0 });
  });

  it('caps the search term length', async () => {
    await route.GET(makeReq({ search: 'y'.repeat(500) }));
    expect(listUsersMock).toHaveBeenCalledWith({ search: 'y'.repeat(200), limit: 25, offset: 0 });
  });

  it('returns 200 on success', async () => {
    listUsersMock.mockResolvedValue(ok({ users: [{ clerkUserId: 'u1' }], total: 1 }));
    const res = await route.GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.users).toHaveLength(1);
  });
});