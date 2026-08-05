import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { getTicketIntelligenceMock, requireAdminGetMock } = vi.hoisted(() => {
  const getTicketIntelligenceMock = vi.fn(async () => state.result);
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { getTicketIntelligence: getTicketIntelligenceMock },
      url: new URL(req.url),
    };
  });
  return { getTicketIntelligenceMock, requireAdminGetMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminGet: requireAdminGetMock };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ turnsToTicket: { ticketSessions: 0, avgTurns: 0, buckets: [] }, responseTimes: { total: 0, rows: [] } });
  getTicketIntelligenceMock.mockClear();
});

describe('GET /api/admin/analytics/tickets', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(new Request('http://x/api/admin/analytics/tickets'));
    expect(res.status).toBe(401);
  });

  it('returns ticket intelligence on success', async () => {
    getTicketIntelligenceMock.mockResolvedValue(ok({ turnsToTicket: { ticketSessions: 1, avgTurns: 2, buckets: [{ label: '1', count: 1 }] }, responseTimes: { total: 1, rows: [] } }));
    const res = await route.GET(new Request('http://x/api/admin/analytics/tickets'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.turnsToTicket.avgTurns).toBe(2);
  });
});