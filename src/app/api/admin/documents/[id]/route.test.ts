import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, NotFoundError } from '@app/domain';

const { requireAdminMock, hardDeleteMock, requireAdminRouteMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const hardDeleteMock = vi.fn();
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return { ok: true as const, session, comp: { hardDeleteDocument: hardDeleteMock } };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  return { requireAdminMock, hardDeleteMock, requireAdminRouteMock };
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
    getComposition: () => ({ hardDeleteDocument: hardDeleteMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  hardDeleteMock.mockReset();
});

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('DELETE /api/admin/documents/[id]', () => {
  it('returns 403 for non-admin', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.DELETE(new Request('http://x/api/admin/documents/1', { method: 'DELETE' }), makeParams('1'));
    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-integer id', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    const res = await route.DELETE(new Request('http://x/api/admin/documents/abc', { method: 'DELETE' }), makeParams('abc'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing document', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    hardDeleteMock.mockResolvedValue(err(new NotFoundError('missing')));
    const res = await route.DELETE(new Request('http://x/api/admin/documents/1', { method: 'DELETE' }), makeParams('1'));
    expect(res.status).toBe(404);
  });

  it('hard-deletes the document and returns ok', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    hardDeleteMock.mockResolvedValue(ok({ documentId: 1 }));
    const res = await route.DELETE(new Request('http://x/api/admin/documents/1', { method: 'DELETE' }), makeParams('1'));
    expect(res.status).toBe(200);
    expect(hardDeleteMock).toHaveBeenCalledWith({ documentId: 1, actorId: 'admin-1' });
  });
});