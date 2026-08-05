import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { getAnalyticsSummaryMock, requireAdminRouteMock } = vi.hoisted(() => {
  const getAnalyticsSummaryMock = vi.fn(async () => state.result);
  const requireAdminRouteMock = vi.fn(async () => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { getAnalyticsSummary: getAnalyticsSummaryMock },
    };
  });
  return { getAnalyticsSummaryMock, requireAdminRouteMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminRoute: requireAdminRouteMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ documentCount: 0, chunkCount: 0, ticketCount: 0, openTicketCount: 0, usersCount: 0, coldStart: true });
  getAnalyticsSummaryMock.mockClear();
});

describe('GET /api/admin/analytics/summary', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('returns the summary on success', async () => {
    getAnalyticsSummaryMock.mockResolvedValue(ok({ documentCount: 3, chunkCount: 10, ticketCount: 2, openTicketCount: 1, usersCount: 5, coldStart: false }));
    const res = await route.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.documentCount).toBe(3);
  });
});