import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, ExternalServiceError } from '@app/domain';

const { requireAdminMock, listAuditMock, requireAdminRouteMock, requireAdminGetMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const listAuditMock = vi.fn();
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return { ok: true as const, session, comp: { listAudit: listAuditMock } };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  const requireAdminGetMock = vi.fn(async (req: Request) => {
    const auth = await requireAdminRouteMock();
    if (!auth.ok) return auth;
    return { ok: true as const, session: auth.session, comp: auth.comp, url: new URL(req.url) };
  });
  return { requireAdminMock, listAuditMock, requireAdminRouteMock, requireAdminGetMock };
});

vi.mock('@/composition', async () => {
  const actual = await vi.importActual<typeof import('@/composition')>('@/composition');
  const { ForbiddenError } = await import('@app/domain');
  const { respond, respondResult } = await import('@/lib/http');
  return {
    ...actual,
    requireAdmin: requireAdminMock,
    requireAdminRoute: requireAdminRouteMock,
    requireAdminGet: requireAdminGetMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    respond,
    respondResult,
    getComposition: () => ({ listAudit: listAuditMock }),
  };
});

import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  listAuditMock.mockReset();
});

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://x/api/admin/audit');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url);
}

describe('GET /api/admin/audit', () => {
  it('returns 403 for non-admin', async () => {
    const { ForbiddenError } = await import('@/composition');
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns 200 with valid JSON for admin', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({
      events: [
        {
          id: 1,
          kind: 'document',
          documentId: 1,
          ticketId: null,
          actorId: 'user_1',
          actorName: 'Alice',
          action: 'upload',
          at: new Date('2025-06-01T10:00:00Z'),
        },
      ],
      total: 1,
    }) as never);

    const res = await route.GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('returns correct JSON shape matching ListAuditResult', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({ events: [], total: 0 }) as never);

    const res = await route.GET(makeReq());
    const body = await res.json();

    expect(body).toHaveProperty('events');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.events)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('passes query params to listAudit', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({ events: [], total: 0 }) as never);

    await route.GET(makeReq({ documentId: '5', ticketId: 'TKT-1001', limit: '25', offset: '10' }));

    expect(listAuditMock).toHaveBeenCalledWith({
      kind: undefined,
      action: undefined,
      actor: undefined,
      from: undefined,
      to: undefined,
      documentId: 5,
      ticketId: 'TKT-1001',
      limit: 25,
      offset: 10,
      actorId: 'admin_1',
    });
  });

  it('passes kind/action/actor/date filters to listAudit', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({ events: [], total: 0 }) as never);

    await route.GET(makeReq({
      kind: 'settings',
      action: 'update',
      actor: 'user_9',
      from: '2025-06-01',
      to: '2025-06-30',
    }));

    expect(listAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'settings',
      action: 'update',
      actor: 'user_9',
      from: new Date('2025-06-01'),
      to: new Date('2025-06-30'),
    }));
  });

  it('returns 400 for an unknown kind', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    const res = await route.GET(makeReq({ kind: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid date', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    const res = await route.GET(makeReq({ from: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when from is after to', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    const res = await route.GET(makeReq({ from: '2025-06-30', to: '2025-06-01' }));
    expect(res.status).toBe(400);
    expect(listAuditMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the date span exceeds one year', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    const res = await route.GET(makeReq({ from: '2020-01-01', to: '2025-06-01' }));
    expect(res.status).toBe(400);
    expect(listAuditMock).not.toHaveBeenCalled();
  });

  it('returns user and settings kinds without dropping them', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({
      events: [
        {
          id: 2,
          kind: 'user',
          action: 'role_change',
          actorId: 'admin_1',
          actorName: 'A',
          targetType: 'user',
          targetId: 'user_2',
          details: { fromRole: 'user', toRole: 'admin' },
          at: new Date('2025-06-02T10:00:00Z'),
        },
        {
          id: 3,
          kind: 'settings',
          action: 'update',
          actorId: 'admin_1',
          actorName: 'A',
          targetType: 'settings',
          targetId: 'app',
          details: { changes: [{ key: 'agentStepBudget', old: 8, new: 5 }] },
          at: new Date('2025-06-03T10:00:00Z'),
        },
      ],
      total: 2,
    }) as never);

    const res = await route.GET(makeReq());
    const body = await res.json();
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['user', 'settings']);
    expect(body.events[1].details.changes).toEqual([{ key: 'agentStepBudget', old: 8, new: 5 }]);
  });

  it('returns empty events when no audit data exists', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(ok({ events: [], total: 0 }) as never);

    const res = await route.GET(makeReq());
    const body = await res.json();

    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('maps listAudit Result errors to 502', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });
    listAuditMock.mockResolvedValue(err(new ExternalServiceError('db down')) as never);

    const res = await route.GET(makeReq());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('external_service');
  });

  it('returns 400 for a malformed ticketId', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' },
    });

    const res = await route.GET(makeReq({ ticketId: 'not a valid id!' }));
    expect(res.status).toBe(400);
  });
});
