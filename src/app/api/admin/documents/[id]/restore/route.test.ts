import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, NotFoundError, GoneError } from '@app/domain';

const { requireAdminMock, restoreDocumentMock, requireAdminRouteMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const restoreDocumentMock = vi.fn();
  const requireAdminRouteMock = vi.fn(async () => {
    try {
      const session = await requireAdminMock();
      return { ok: true as const, session, comp: { restoreDocument: restoreDocumentMock } };
    } catch (err) {
      if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) };
      }
      throw err;
    }
  });
  return { requireAdminMock, restoreDocumentMock, requireAdminRouteMock };
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
    getComposition: () => ({ restoreDocument: restoreDocumentMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  restoreDocumentMock.mockReset();
});

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/admin/documents/[id]/restore', () => {
  it('returns 403 for non-admin', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.POST(new Request('http://x/api/admin/documents/1/restore', { method: 'POST' }), makeParams('1'));
    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-integer id', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    const res = await route.POST(new Request('http://x/api/admin/documents/abc/restore', { method: 'POST' }), makeParams('abc'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing document', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    restoreDocumentMock.mockResolvedValue(err(new NotFoundError('missing')));
    const res = await route.POST(new Request('http://x/api/admin/documents/1/restore', { method: 'POST' }), makeParams('1'));
    expect(res.status).toBe(404);
  });

  it('returns 410 when the restore window has expired', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    restoreDocumentMock.mockResolvedValue(err(new GoneError('expired')));
    const res = await route.POST(new Request('http://x/api/admin/documents/1/restore', { method: 'POST' }), makeParams('1'));
    expect(res.status).toBe(410);
  });

  it('restores the document and returns ok', async () => {
    requireAdminMock.mockResolvedValue({ user: { id: 'admin-1' } });
    restoreDocumentMock.mockResolvedValue(ok({ document: { id: 1 } }));
    const res = await route.POST(new Request('http://x/api/admin/documents/1/restore', { method: 'POST' }), makeParams('1'));
    expect(res.status).toBe(200);
    expect(restoreDocumentMock).toHaveBeenCalledWith(1, 'admin-1');
  });
});