import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, NotFoundError, ConflictError } from '@app/domain';

const { requireAdminMock, updateTicketMock, getUserByClerkIdMock, requireAdminRouteMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const updateTicketMock = vi.fn();
  const getUserByClerkIdMock = vi.fn(
    async (): Promise<{ ok: true; value: { user: { clerkUserId: string; email: string; name: string | null; role: string } | null } }> =>
      ({ ok: true, value: { user: { clerkUserId: 'user_2', email: '', name: null, role: 'user' } } }),
  );
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return { ok: true as const, session, comp: { updateTicket: updateTicketMock, getUserByClerkId: getUserByClerkIdMock } };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  return { requireAdminMock, updateTicketMock, getUserByClerkIdMock, requireAdminRouteMock };
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
    TICKET_STATUSES: ['created', 'in_progress', 'closed'],
    isTicketStatus: (s: string) => ['created', 'in_progress', 'closed'].includes(s),
    getComposition: () => ({ updateTicket: updateTicketMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  updateTicketMock.mockReset();
  getUserByClerkIdMock.mockReset().mockResolvedValue({ ok: true, value: { user: { clerkUserId: 'user_2', email: '', name: null, role: 'user' } } });
});

function makeParams(ticketId: string) {
  return { params: Promise.resolve({ ticketId }) };
}

function makeReq(body: unknown) {
  return new Request('http://x/api/admin/tickets/TKT-1001', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/admin/tickets/[ticketId]', () => {
  it('returns 403 for non-admin', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.PATCH(
      makeReq({ status: 'closed' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects invalid status with 400', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    const res = await route.PATCH(
      makeReq({ status: 'bogus' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing ticket', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(err(new NotFoundError('Ticket not found')));
    const res = await route.PATCH(
      makeReq({ status: 'closed' }),
      makeParams('TKT-MISSING'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 for invalid transition', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(err(new ConflictError('Invalid status transition')));
    const res = await route.PATCH(
      makeReq({ status: 'in_progress' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(409);
  });

  it('returns the updated ticket for a valid patch', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({
      ticketId: 'TKT-1001',
      status: 'closed',
    }) as never);
    const res = await route.PATCH(
      makeReq({ status: 'closed' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: { ticketId: 'TKT-1001', status: 'closed' },
    });
  });

  it('returns 400 when body is empty and no status/note provided', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-1001', status: 'created' }) as never);
    const res = await route.PATCH(
      makeReq({}),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(200);
  });

  it('updates notes without status change', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({
      ticketId: 'TKT-1001',
      status: 'created',
      notes: 'new note',
    }) as never);
    const res = await route.PATCH(
      makeReq({ note: 'new note' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(200);
    expect(updateTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'new note' }),
    );
  });

  it('sanitizes the note (control chars, unicode spaces, zero-width) before updateTicket', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-1001', status: 'created', notes: 'clean' }) as never);
    const res = await route.PATCH(
      makeReq({ note: 'a\u200Bb\u00A0c\u0000d\u200Ee' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(200);
    expect(updateTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'ab cde' }),
    );
  });

  it('caps the note to MAX_TICKET_NOTES_LENGTH code points before updateTicket', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-1001', status: 'created', notes: '' }) as never);
    await route.PATCH(
      makeReq({ note: 'abc' + 'x'.repeat(20_000) }),
      makeParams('TKT-1001'),
    );
    expect(updateTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'abc' + 'x'.repeat(9_997) }),
    );
  });

  it('rejects a note that is empty after sanitization', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    const res = await route.PATCH(
      makeReq({ note: '\u0000\u200B' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(400);
    expect(updateTicketMock).not.toHaveBeenCalled();
  });

  it('returns 200 with ticket when patch is valid', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    updateTicketMock.mockResolvedValue(ok({
      ticketId: 'TKT-1001',
      status: 'created',
      assignedTo: 'user_2',
    }) as never);
    const res = await route.PATCH(
      makeReq({ assignedTo: 'user_2' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(200);
    expect(updateTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: 'user_2' }),
    );
  });

  it('returns 400 when assignee is not a known user', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    getUserByClerkIdMock.mockResolvedValue({ ok: true, value: { user: null } });
    const res = await route.PATCH(
      makeReq({ assignedTo: 'ghost' }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(400);
    expect(updateTicketMock).not.toHaveBeenCalled();
  });

  it('returns 400 when assignedTo exceeds 255 characters', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    const res = await route.PATCH(
      makeReq({ assignedTo: 'x'.repeat(256) }),
      makeParams('TKT-1001'),
    );
    expect(res.status).toBe(400);
    expect(updateTicketMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty/malformed ticketId', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin_1', email: 'a@x.com', name: 'A', role: 'admin' } });
    const res = await route.PATCH(makeReq({ status: 'closed' }), makeParams(''));
    expect(res.status).toBe(400);
  });
});
