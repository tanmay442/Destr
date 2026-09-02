import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err, NotFoundError, ExternalServiceError } from '@app/domain';

const { verifyMock, ingestQueuedDocumentMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  ingestQueuedDocumentMock: vi.fn(),
}));

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify = verifyMock;
  },
}));

vi.mock('@/composition', () => ({
  getComposition: () => ({ ingestQueuedDocument: ingestQueuedDocumentMock }),
}));

import * as route from './route';

const ORIGINAL_ENV = { ...process.env };

function signedToken(iatSec?: number): string {
  const iat = iatSec ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, test: nonce++ })).toString('base64url');
  return `${header}.${payload}.sig`;
}

let nonce = 0;

function signedPost(body: string, signature = signedToken()): Request {
  return new Request('http://x/api/admin/ingest-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'upstash-signature': signature },
    body,
  });
}

beforeEach(() => {
  verifyMock.mockReset();
  ingestQueuedDocumentMock.mockReset();
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'nxt';
});

afterEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_CURRENT_SIGNING_KEY;
  process.env.QSTASH_NEXT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_NEXT_SIGNING_KEY;
});

describe('POST /api/admin/ingest-worker', () => {
  it('returns 401 when signing keys are not configured', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 413 when content-length exceeds 1MB', async () => {
    const req = new Request('http://x/api/admin/ingest-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'upstash-signature': signedToken(), 'content-length': String(1024 * 1024 + 1) },
      body: JSON.stringify({ documentId: 1 }),
    });
    const res = await route.POST(req);
    expect(res.status).toBe(413);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signature verification fails', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 401 when Receiver.verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('bad signature'));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature has no timestamp', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 }), 'no-timestamp'));
    expect(res.status).toBe(401);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a replayed signature older than 5 minutes', async () => {
    verifyMock.mockResolvedValue(true);
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 }), signedToken(old)));
    expect(res.status).toBe(401);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid JSON body', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost('not-json'));
    expect(res.status).toBe(400);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 400 when documentId is missing or non-integer', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 'x' })));
    expect(res.status).toBe(400);
    expect(ingestQueuedDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 200 on a happy-path ingest (status done)', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(ok({ status: 'done', chunks: 7 }));
    const req = signedPost(JSON.stringify({ documentId: 5 }));
    const res = await route.POST(req);
    expect(res.status).toBe(200);
    expect(ingestQueuedDocumentMock).toHaveBeenCalledWith(5, undefined, req.signal);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, status: 'done', chunks: 7 });
  });

  it('returns 200 without re-processing an already-done doc (idempotent)', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(ok({ status: 'already-done', chunks: 0 }));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(200);
  });

  it('returns 409 when the doc is already being ingested (busy)', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(ok({ status: 'busy', chunks: 0 }));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(409);
  });

  it('returns 489 with Upstash-NonRetryable-Error when the document is not found (L7)', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(err(new NotFoundError('missing')));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 99 })));
    expect(res.status).toBe(489);
    expect(res.headers.get('Upstash-NonRetryable-Error')).toBe('true');
  });

  it('returns 500 on an embed/ingest failure so QStash retries', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(err(new ExternalServiceError('embed down')));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(500);
  });

  it('passes replay handling to the database idempotency guard', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock
      .mockResolvedValueOnce(ok({ status: 'done', chunks: 7 }))
      .mockResolvedValueOnce(ok({ status: 'already-done', chunks: 0 }));
    const signature = signedToken();
    const first = await route.POST(signedPost(JSON.stringify({ documentId: 5 }), signature));
    expect(first.status).toBe(200);
    const second = await route.POST(signedPost(JSON.stringify({ documentId: 5 }), signature));
    expect(second.status).toBe(200);
    const json = await second.json();
    expect(json).toMatchObject({ ok: true, status: 'already-done', chunks: 0 });
    expect(ingestQueuedDocumentMock).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe across different signatures', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(ok({ status: 'done', chunks: 7 }));
    await route.POST(signedPost(JSON.stringify({ documentId: 5 }), signedToken()));
    await route.POST(signedPost(JSON.stringify({ documentId: 5 }), signedToken()));
    expect(ingestQueuedDocumentMock).toHaveBeenCalledTimes(2);
  });
});
