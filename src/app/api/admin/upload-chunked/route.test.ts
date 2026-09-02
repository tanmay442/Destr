// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, rateOk: true, result: undefined as unknown },
}));

const { uploadChunkedMock, rateLimitMock, requireAdminRouteMock } = vi.hoisted(() => {
  const uploadChunkedMock = vi.fn(async () => state.result);
  const rateLimitMock = vi.fn(async () => (state.rateOk ? { ok: true, remaining: 9, resetMs: 0 } : { ok: false, retryAfterMs: 5000 }));
  const requireAdminRouteMock = vi.fn(async () => {
    if (state.unauthorized) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true as const,
      session: { user: { id: 'admin-1' } },
      comp: { uploadChunkedMarkdown: uploadChunkedMock, rateLimit: rateLimitMock },
    };
  });
  return { uploadChunkedMock, rateLimitMock, requireAdminRouteMock };
});

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  const { respond, respondResult } = await import('@/lib/http');
  return { ...actual, respond, respondResult, requireAdminRoute: requireAdminRouteMock };
});

import * as route from './route';

const MD_MAX = 25_000_000;
const BOUNDARY = '----vitest-boundary';

type Field = [name: string, value: string, filename?: string];

function multipartRequest(fields: Field[]): Request {
  const line = `--${BOUNDARY}`;
  let body = '';
  for (const [name, value, filename] of fields) {
    body += filename
      ? `${line}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${value}\r\n`
      : `${line}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `${line}--\r\n`;
  return new Request('http://x/api/admin/upload-chunked', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
}

beforeEach(() => {
  state.unauthorized = false;
  state.rateOk = true;
  state.result = ok({ documentId: 1, chunks: 2, status: 'inserted' });
  uploadChunkedMock.mockClear();
  rateLimitMock.mockClear();
});

describe('POST /api/admin/upload-chunked', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.POST(multipartRequest([['md', 'x', 'a.md']]));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    state.rateOk = false;
    const res = await route.POST(multipartRequest([['md', 'x', 'a.md']]));
    expect(res.status).toBe(429);
    expect(uploadChunkedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the raw body exceeds the total cap (chunked-safe)', async () => {
    const req = new Request('http://x/api/admin/upload-chunked', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: 'a'.repeat(50 * 1024 * 1024 + 1),
    });
    const res = await route.POST(req);
    expect(res.status).toBe(400);
    expect(uploadChunkedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the md field is missing', async () => {
    const res = await route.POST(multipartRequest([['name', 'a']]));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the markdown exceeds the md cap', async () => {
    const big = 'a'.repeat(MD_MAX + 1);
    const res = await route.POST(multipartRequest([['md', big, 'a.md']]));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an oversized delimiter', async () => {
    const res = await route.POST(multipartRequest([['md', 'a---chunk---b', 'a.md'], ['delimiter', 'z'.repeat(201)]]));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the chunk count exceeds the cap', async () => {
    const res = await route.POST(multipartRequest([['md', 'x---chunk---'.repeat(5001), 'a.md'], ['delimiter', '---chunk---']]));
    expect(res.status).toBe(400);
    expect(uploadChunkedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a single chunk is too large', async () => {
    const res = await route.POST(multipartRequest([['md', 'y'.repeat(1_000_001), 'a.md']]));
    expect(res.status).toBe(400);
    expect(uploadChunkedMock).not.toHaveBeenCalled();
  });

  it('ingests a valid pre-chunked upload', async () => {
    const req = multipartRequest([['md', 'a---chunk---b', 'a.md']]);
    const res = await route.POST(req);
    expect(res.status).toBe(200);
    expect(uploadChunkedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'a.md',
        delimiter: '---chunk---',
        uploadedBy: 'admin-1',
        signal: req.signal,
      }),
    );
  });

  it('honors a custom name field', async () => {
    await route.POST(multipartRequest([['md', 'a---chunk---b', 'a.md'], ['name', 'custom name.md']]));
    expect(uploadChunkedMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'custom name.md' }));
  });
});
