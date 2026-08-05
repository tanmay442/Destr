import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAdminMock, requireAdminDocumentMock, blobStorageMock } = vi.hoisted(() => {
  const requireAdminMock = vi.fn();
  const blobStorageMock = { stream: vi.fn(), signedUrl: undefined as ((key: string, ttlSec: number) => Promise<string>) | undefined };
  const requireAdminDocumentMock = vi.fn(
    async (context: { params: Promise<{ id: string }> }) => {
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
      if (!Number.isInteger(docId)) return { ok: false, response: new Response('Invalid id', { status: 400 }) };
      return {
        ok: true,
        document: { id: docId, fileName: 'report.pdf', storageKey: 'docs/1/report.pdf', deletedAt: null },
        comp: { blobStorage: blobStorageMock },
      };
    },
  );
  return { requireAdminMock, requireAdminDocumentMock, blobStorageMock };
});

vi.mock('@/composition', async () => {
  const { ForbiddenError } = await import('@app/domain');
  return {
    requireAdmin: requireAdminMock,
    requireAdminDocument: requireAdminDocumentMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    getComposition: () => ({ blobStorage: blobStorageMock }),
  };
});

import { ForbiddenError } from '@/composition';
import * as route from './route';

beforeEach(() => {
  requireAdminMock.mockReset();
  blobStorageMock.stream.mockReset();
  blobStorageMock.signedUrl = undefined;
});

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/admin/documents/[id]/download', () => {
  it('returns 403 when requireAdmin throws', async () => {
    requireAdminMock.mockRejectedValue(new ForbiddenError());
    const res = await route.GET(new Request('http://x/api/admin/documents/1/download'), makeParams('1'));
    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-integer id', async () => {
    requireAdminMock.mockResolvedValue({});
    const res = await route.GET(new Request('http://x/api/admin/documents/abc/download'), makeParams('abc'));
    expect(res.status).toBe(400);
  });

  it('streams the PDF with an attachment disposition', async () => {
    requireAdminMock.mockResolvedValue({});
    blobStorageMock.stream.mockResolvedValue(new Response(Buffer.from('%PDF-1.4')).body);
    const res = await route.GET(new Request('http://x/api/admin/documents/1/download'), makeParams('1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(blobStorageMock.stream).toHaveBeenCalledWith('docs/1/report.pdf');
  });

  it('redirects to a signed URL when the adapter supports it', async () => {
    requireAdminMock.mockResolvedValue({});
    blobStorageMock.signedUrl = vi.fn().mockResolvedValue('https://r2.example/signed') as (key: string, ttlSec: number) => Promise<string>;
    const res = await route.GET(new Request('http://x/api/admin/documents/1/download'), makeParams('1'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://r2.example/signed');
  });
});