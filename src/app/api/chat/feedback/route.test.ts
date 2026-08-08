import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, NotFoundError, RateLimitedError } from '@app/domain';

const { authMock, submitMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  submitMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/nextjs/server')>()),
  auth: authMock,
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    getComposition: () => ({ submitChatFeedback: submitMock, enforceRateLimit: rateLimitMock }),
  };
});

import * as route from './route';

const TURN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/chat/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ userId: 'user_1' });
  submitMock.mockReset().mockResolvedValue(ok({ ok: true }));
  rateLimitMock.mockReset().mockResolvedValue(ok({ remaining: 29, resetMs: 60_000 }));
});

describe('POST /api/chat/feedback', () => {
  it('rejects a cross-site request with 403', async () => {
    const res = await route.POST(
      post({ turnId: TURN, feedback: 1 }, { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no signed-in user', async () => {
    authMock.mockResolvedValue({ userId: null });
    const res = await route.POST(post({ turnId: TURN, feedback: 1 }));
    expect(res.status).toBe(401);
  });

  it('returns 429 with Retry-After when the per-user rate limit is exceeded', async () => {
    rateLimitMock.mockResolvedValue(err(new RateLimitedError('Rate limit exceeded', 5_000)));
    const res = await route.POST(post({ turnId: TURN, feedback: 1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(submitMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith({ key: 'feedback:user_1', limit: 30, windowMs: 60_000 });
  });

  it('returns 415 for a non-JSON content type', async () => {
    const res = await route.POST(
      new Request('http://localhost/api/chat/feedback', { method: 'POST', body: 'x' }),
    );
    expect(res.status).toBe(415);
  });

  it('returns 400 for a malformed uuid', async () => {
    const res = await route.POST(post({ turnId: 'nope', feedback: 1 }));
    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-v4 uuid', async () => {
    const v1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const res = await route.POST(post({ turnId: v1, feedback: 1 }));
    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the declared content-length exceeds the cap', async () => {
    const res = await route.POST(
      post({ turnId: TURN, feedback: 1 }, { 'content-length': '99999999' }),
    );
    expect(res.status).toBe(413);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range feedback value', async () => {
    const res = await route.POST(post({ turnId: TURN, feedback: 2 }));
    expect(res.status).toBe(400);
  });

  it('upserts and returns 200 with the current user id', async () => {
    const res = await route.POST(post({ turnId: TURN, feedback: -1, documentIds: [1, 2], chunkIds: [3] }));
    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith({
      userId: 'user_1',
      turnId: TURN,
      feedback: -1,
      documentIds: [1, 2],
      chunkIds: [3],
    });
  });

  it('propagates a 404 when the chat turn is not yet flushed', async () => {
    submitMock.mockResolvedValue(err(new NotFoundError('Chat turn not found')));
    const res = await route.POST(post({ turnId: TURN, feedback: 1 }));
    expect(res.status).toBe(404);
  });
});
