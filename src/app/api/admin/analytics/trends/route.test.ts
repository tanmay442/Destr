import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { getAnalyticsTrendsMock, requireAdminGetMock } = vi.hoisted(() => {
  const getAnalyticsTrendsMock = vi.fn(async () => state.result);
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { getAnalyticsTrends: getAnalyticsTrendsMock },
      url: new URL(req.url),
    };
  });
  return { getAnalyticsTrendsMock, requireAdminGetMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminGet: requireAdminGetMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ days: 84, points: [] });
  getAnalyticsTrendsMock.mockClear();
});

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://x/api/admin/analytics/trends');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe('GET /api/admin/analytics/trends', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('clamps days to 365', async () => {
    await route.GET(makeReq({ days: '100000' }));
    expect(getAnalyticsTrendsMock).toHaveBeenCalledWith(
      expect.objectContaining({ days: 365 }),
    );
  });

  it('passes a valid days value through', async () => {
    await route.GET(makeReq({ days: '30' }));
    expect(getAnalyticsTrendsMock).toHaveBeenCalledWith(
      expect.objectContaining({ days: 30 }),
    );
  });

  it('returns 200 on success', async () => {
    getAnalyticsTrendsMock.mockResolvedValue(ok({ days: 84, points: [] }));
    const res = await route.GET(makeReq());
    expect(res.status).toBe(200);
  });
});