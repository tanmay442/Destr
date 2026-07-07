import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAdminMock, getDocumentByIdMock, requireAdminDocumentMock, blobStorageMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const getDocumentByIdMock = vi.fn();
  const blobStorageMock = {
    put: vi.fn(),
    get: vi.fn(),
    stream: vi.fn(),
    delete: vi.fn(),
    signedUrl: undefined as ((key: string, ttlSec: number) => Promise<string>) | undefined,
  };
  const requireAdminDocumentMock = vi.fn(
    async (context: { params: Promise<{ id: string }> }, opts: { allowDeleted?: boolean } = {}) => {
      try {
        await requireAdminMock();
      } catch (err) {
        if (err instanceof Error && err.constructor.name === 'ForbiddenError') {
          return { ok: false, response: new Response('Forbidden', { status: 403 }) };
        }
        throw err;
      }
      const { id } = await context.params;
      const docId = Number(id);
      if (!Number.isInteger(docId)) {
        return { ok: false, response: new Response('Invalid id', { status: 400 }) };
      }
      const doc = await getDocumentByIdMock(docId);
      if (!doc) return { ok: false, response: new Response('Not found', { status: 404 }) };
      if (!opts.allowDeleted && doc.deletedAt) {
        return { ok: false, response: new Response('Gone', { status: 410 }) };
      }
      if (!doc.storageKey) {
        return { ok: false, response: new Response('File unavailable', { status: 404 }) };
      }
      return { ok: true, document: doc, comp: { blobStorage: blobStorageMock } };
    },
  );
  return { requireAdminMock, getDocumentByIdMock, requireAdminDocumentMock, blobStorageMock };
});

vi.mock('@/composition', async () => {
  const { ForbiddenError } = await import('@app/domain');
  return {
    requireAdmin: requireAdminMock,
    requireAdminDocument: requireAdminDocumentMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    getComposition: () => ({ getDocumentById: getDocumentByIdMock, blobStorage: blobStorageMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  getDocumentByIdMock.mockReset();
  blobStorageMock.stream.mockReset();
  blobStorageMock.signedUrl = undefined;
});

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/admin/documents/[id]/blob', () => {
  it('returns 403 when requireAdmin throws', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-integer id', async () => {
    requireAdminMock.mockResolvedValue({});
    const res = await route.GET(
      new Request('http://x/api/admin/documents/abc/blob'),
      makeParams('abc'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing document', async () => {
    requireAdminMock.mockResolvedValue({});
    getDocumentByIdMock.mockResolvedValue(null);
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 410 for a soft-deleted document', async () => {
    requireAdminMock.mockResolvedValue({});
    getDocumentByIdMock.mockResolvedValue({
      id: 1,
      fileName: 'a.pdf',
      storageKey: 'docs/1/a.pdf',
      deletedAt: new Date(),
    });
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(410);
  });

  it('returns 404 when storageKey is null', async () => {
    requireAdminMock.mockResolvedValue({});
    getDocumentByIdMock.mockResolvedValue({
      id: 1,
      fileName: 'a.pdf',
      storageKey: null,
      deletedAt: null,
    });
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(404);
  });

  it('streams the PDF from blobStorage when no signedUrl', async () => {
    requireAdminMock.mockResolvedValue({});
    getDocumentByIdMock.mockResolvedValue({
      id: 1,
      fileName: 'a.pdf',
      storageKey: 'docs/1/a.pdf',
      deletedAt: null,
    });
    const pdf = Buffer.from('%PDF-1.4 hello');
    blobStorageMock.stream.mockResolvedValue(new Response(pdf).body);
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(200);
    expect(blobStorageMock.stream).toHaveBeenCalledWith('docs/1/a.pdf');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
  });

  it('redirects to a signed URL when the adapter supports it', async () => {
    requireAdminMock.mockResolvedValue({});
    getDocumentByIdMock.mockResolvedValue({
      id: 1,
      fileName: 'a.pdf',
      storageKey: 'docs/1/a.pdf',
      deletedAt: null,
    });
    blobStorageMock.signedUrl = vi.fn().mockResolvedValue('https://r2.example/signed') as (key: string, ttlSec: number) => Promise<string>;
    const res = await route.GET(
      new Request('http://x/api/admin/documents/1/blob'),
      makeParams('1'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://r2.example/signed');
    expect(blobStorageMock.signedUrl).toHaveBeenCalledWith('docs/1/a.pdf', 300);
  });
});
