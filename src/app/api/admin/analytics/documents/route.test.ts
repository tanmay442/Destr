import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { getDocumentAnalyticsMock, requireAdminGetMock } = vi.hoisted(() => {
  const getDocumentAnalyticsMock = vi.fn(async () => state.result);
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { getDocumentAnalytics: getDocumentAnalyticsMock },
      url: new URL(req.url),
    };
  });
  return { getDocumentAnalyticsMock, requireAdminGetMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminGet: requireAdminGetMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ utility: [], zeroHit: [], feedback: {} });
  getDocumentAnalyticsMock.mockClear();
});

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://x/api/admin/analytics/documents');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe('GET /api/admin/analytics/documents', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('caps limit to MAX_LIST_LIMIT', async () => {
    await route.GET(makeReq({ limit: '999999' }));
    expect(getDocumentAnalyticsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('passes a valid limit through', async () => {
    await route.GET(makeReq({ limit: '25' }));
    expect(getDocumentAnalyticsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it('rejects an inverted date range', async () => {
    const res = await route.GET(makeReq({ from: '2025-06-30', to: '2025-06-01' }));
    expect(res.status).toBe(400);
    expect(getDocumentAnalyticsMock).not.toHaveBeenCalled();
  });

  it('rejects a date range exceeding one year', async () => {
    const res = await route.GET(makeReq({ from: '2020-01-01', to: '2025-06-01' }));
    expect(res.status).toBe(400);
    expect(getDocumentAnalyticsMock).not.toHaveBeenCalled();
  });

  it('returns 200 on success', async () => {
    getDocumentAnalyticsMock.mockResolvedValue(ok({ utility: [], zeroHit: [], feedback: {} }));
    const res = await route.GET(makeReq());
    expect(res.status).toBe(200);
  });
});