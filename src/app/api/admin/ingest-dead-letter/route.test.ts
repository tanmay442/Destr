import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { verifyMock, ingestDeadLetterMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  ingestDeadLetterMock: vi.fn(),
}));

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify = verifyMock;
  },
}));

vi.mock('@/composition', () => ({
  getComposition: () => ({ ingestDeadLetter: ingestDeadLetterMock }),
}));

import * as route from './route';

const ORIGINAL_ENV = { ...process.env };

function signedToken(iatSec = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: iatSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function signedPost(body: string, signature = signedToken()): Request {
  return new Request('http://x/api/admin/ingest-dead-letter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'upstash-signature': signature },
    body,
  });
}

beforeEach(() => {
  verifyMock.mockReset();
  ingestDeadLetterMock.mockReset();
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'nxt';
});

afterEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_CURRENT_SIGNING_KEY;
  process.env.QSTASH_NEXT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_NEXT_SIGNING_KEY;
});

describe('POST /api/admin/ingest-dead-letter', () => {
  it('returns 401 when signing keys are not configured', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 413 when content-length exceeds 1MB', async () => {
    const req = new Request('http://x/api/admin/ingest-dead-letter', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'upstash-signature': signedToken(),
        'content-length': String(1024 * 1024 + 1),
      },
      body: JSON.stringify({ documentId: 1 }),
    });
    const res = await route.POST(req);
    expect(res.status).toBe(413);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signature verification fails', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 401 when Receiver.verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('bad signature'));
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 })));
    expect(res.status).toBe(401);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a replayed signature older than 5 minutes', async () => {
    verifyMock.mockResolvedValue(true);
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 1 }), signedToken(old)));
    expect(res.status).toBe(401);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid JSON body', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost('not-json'));
    expect(res.status).toBe(400);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('returns 400 when documentId is missing or non-integer', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 'x' })));
    expect(res.status).toBe(400);
    expect(ingestDeadLetterMock).not.toHaveBeenCalled();
  });

  it('records a DLQ delivery and marks the document failed on the happy path', async () => {
    verifyMock.mockResolvedValue(true);
    ingestDeadLetterMock.mockResolvedValue(undefined);
    const res = await route.POST(signedPost(JSON.stringify({ documentId: 5 })));
    expect(res.status).toBe(200);
    expect(ingestDeadLetterMock).toHaveBeenCalledWith({
      documentId: 5,
      payload: { documentId: 5 },
      error: 'QStash ingest delivery failed after retry budget exhausted',
    });
  });

  it('accepts the wrapped { body: { documentId } } DLQ delivery shape', async () => {
    verifyMock.mockResolvedValue(true);
    ingestDeadLetterMock.mockResolvedValue(undefined);
    const res = await route.POST(signedPost(JSON.stringify({ messageId: 'm1', body: { documentId: 9 } })));
    expect(res.status).toBe(200);
    expect(ingestDeadLetterMock).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 9, payload: { messageId: 'm1', body: { documentId: 9 } } }),
    );
  });
});
