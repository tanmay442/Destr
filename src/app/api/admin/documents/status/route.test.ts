import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, pending: 3 },
}));

const { countPendingIngestMock, requireAdminRouteMock } = vi.hoisted(() => {
  const countPendingIngestMock = vi.fn(async () => state.pending);
  const requireAdminRouteMock = vi.fn(async () => {
    if (state.unauthorized) {
      return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    }
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { countPendingIngest: countPendingIngestMock },
    };
  });
  return { countPendingIngestMock, requireAdminRouteMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  return { ...actual, requireAdminRoute: requireAdminRouteMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.pending = 3;
  countPendingIngestMock.mockClear();
});

describe('GET /api/admin/documents/status', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(new Request('http://x/api/admin/documents/status'));
    expect(res.status).toBe(401);
  });

  it('returns the pending count from a single aggregate call', async () => {
    const res = await route.GET(new Request('http://x/api/admin/documents/status'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ pending: 3 });
    expect(countPendingIngestMock).toHaveBeenCalledOnce();
  });
});
