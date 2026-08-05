import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, result: undefined as unknown },
}));

const { listTicketsMock, requireAdminGetMock } = vi.hoisted(() => {
  const listTicketsMock = vi.fn(async () => state.result);
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { listTickets: listTicketsMock },
      url: new URL(req.url),
    };
  });
  return { listTicketsMock, requireAdminGetMock };
});

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  const { respond, respondResult } = await import('@/lib/http');
  return {
    ...actual,
    respond,
    respondResult,
    requireAdminGet: requireAdminGetMock,
  };
});

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.result = ok({ tickets: [], total: 0 });
  listTicketsMock.mockClear();
});

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://x/api/admin/tickets');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe('GET /api/admin/tickets', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('passes filters and pagination to listTickets', async () => {
    await route.GET(makeReq({ status: 'open', assignee: 'user_2', search: 'billing', limit: '50', offset: '0' }));
    expect(listTicketsMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined, assignee: 'user_2', search: 'billing', limit: 50, offset: 0, actorId: 'admin-1' }),
    );
  });

  it('caps the search term length', async () => {
    await route.GET(makeReq({ search: 'x'.repeat(500) }));
    expect(listTicketsMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'x'.repeat(200) }),
    );
  });

  it('returns 200 on success', async () => {
    listTicketsMock.mockResolvedValue(ok({ tickets: [], total: 0 }));
    const res = await route.GET(makeReq());
    expect(res.status).toBe(200);
  });
});