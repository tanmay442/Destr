import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { verifyMock, judgeRelevanceMock, judgeFaithfulnessMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  judgeRelevanceMock: vi.fn(async () => ({ score: 0.8, reason: 'relevant' })),
  judgeFaithfulnessMock: vi.fn(async () => ({ score: 0.9, citationPrecision: 0.85, reason: 'grounded' })),
}));

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify = verifyMock;
  },
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));

vi.mock('@/composition', () => ({
  getComposition: () => ({ chatEventBatcher: {} }),
  judgeRelevance: judgeRelevanceMock,
  judgeFaithfulness: judgeFaithfulnessMock,
}));

import * as route from './route';

const ORIGINAL_ENV = { ...process.env };

let nonce = 0;

function signedToken(iatSec?: number): string {
  const iat = iatSec ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, test: nonce++ })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function judgeBody(): string {
  return JSON.stringify({
    kind: 'judge',
    turnId: 'turn-1',
    payload: {
      question: 'How do I reset my password?',
      snippetsJson: JSON.stringify(['Reset it in settings.']),
      documents: 'Reset it in settings.',
      answer: 'Reset it in settings.',
    },
  });
}

function signedPost(body: string, signature = signedToken()): Request {
  return new Request('http://x/api/queue/judge-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'upstash-signature': signature },
    body,
  });
}

beforeEach(() => {
  verifyMock.mockReset();
  judgeRelevanceMock.mockClear();
  judgeFaithfulnessMock.mockClear();
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'nxt';
});

afterEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_CURRENT_SIGNING_KEY;
  process.env.QSTASH_NEXT_SIGNING_KEY = ORIGINAL_ENV.QSTASH_NEXT_SIGNING_KEY;
});

describe('POST /api/queue/judge-worker', () => {
  it('returns 401 when signing keys are not configured', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await route.POST(signedPost(judgeBody()));
    expect(res.status).toBe(401);
    expect(judgeRelevanceMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signature verification fails', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await route.POST(signedPost(judgeBody()));
    expect(res.status).toBe(401);
    expect(judgeRelevanceMock).not.toHaveBeenCalled();
  });

  it('returns 401 when Receiver.verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('bad signature'));
    const res = await route.POST(signedPost(judgeBody()));
    expect(res.status).toBe(401);
    expect(judgeRelevanceMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a replayed signature older than 5 minutes', async () => {
    verifyMock.mockResolvedValue(true);
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await route.POST(signedPost(judgeBody(), signedToken(old)));
    expect(res.status).toBe(401);
    expect(judgeRelevanceMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-judge or malformed job', async () => {
    verifyMock.mockResolvedValue(true);
    for (const body of [
      'not-json',
      JSON.stringify({ kind: 'ingest', turnId: 't' }),
      JSON.stringify({ kind: 'judge' }),
      JSON.stringify({ kind: 'judge', turnId: 't', payload: { question: 42 } }),
    ]) {
      const res = await route.POST(signedPost(body));
      expect(res.status).toBe(400);
    }
    expect(judgeRelevanceMock).not.toHaveBeenCalled();
  });

  it('returns 200 and runs the judge on a valid job', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await route.POST(signedPost(judgeBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(judgeRelevanceMock).toHaveBeenCalledTimes(1);
    expect(judgeFaithfulnessMock).toHaveBeenCalledTimes(1);
  });

  it('is safe under repeat delivery (idempotent scoring)', async () => {
    verifyMock.mockResolvedValue(true);
    const first = await route.POST(signedPost(judgeBody()));
    const second = await route.POST(signedPost(judgeBody()));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(judgeRelevanceMock).toHaveBeenCalledTimes(2);
  });
});
