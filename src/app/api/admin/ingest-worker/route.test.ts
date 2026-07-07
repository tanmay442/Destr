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

function signedPost(body: string, signature = 'sig'): Request {
  return new Request('http://x/api/admin/ingest-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'upstash-signature': signature },
    body,
  });
}

describe('POST /api/admin/ingest-worker', () => {
  it('returns 401 when signing keys are not configured', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
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
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(200);
    expect(ingestQueuedDocumentMock).toHaveBeenCalledWith(5);
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

  it('returns 404 when the document is not found', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(err(new NotFoundError('missing')));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 99 })));
    expect(res.status).toBe(404);
  });

  it('returns 500 on an embed/ingest failure so QStash retries', async () => {
    verifyMock.mockResolvedValue(true);
    ingestQueuedDocumentMock.mockResolvedValue(err(new ExternalServiceError('embed down')));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(500);
  });
});
