import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, RateLimitedError, MAX_LEGACY_LIST_OFFSET } from '@app/domain';

const { authMock, listMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  listMock: vi.fn(),
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
    getComposition: () => ({
      listConversations: listMock,
      rateLimit: rateLimitMock,
    }),
  };
});

import * as route from './route';

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ userId: 'user_1' });
  listMock.mockReset().mockResolvedValue(ok({ conversations: [] }));
  rateLimitMock.mockReset().mockResolvedValue({ ok: true, remaining: 59, resetMs: 60_000 });
});

function get(query = '') {
  return new Request(`http://localhost/api/chat/conversations${query}`);
}

describe('GET /api/chat/conversations', () => {
  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue({ userId: null });
    const res = await route.GET(get());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when rate limited', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, retryAfterMs: 7_000 });
    const res = await route.GET(get());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(listMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith('chat_history:user_1', { limit: 60, windowMs: 60_000 });
  });

  it('defaults pagination when no query params are present', async () => {
    await route.GET(get());
    expect(listMock).toHaveBeenCalledWith({ userId: 'user_1' });
  });

  it('forwards numeric limit and offset', async () => {
    await route.GET(get('?limit=10&offset=25'));
    expect(listMock).toHaveBeenCalledWith({ userId: 'user_1', limit: 10, offset: 25 });
  });

  it('does not clamp conversation offsets to the page-size limit', async () => {
    await route.GET(get('?limit=100&offset=200'));
    expect(listMock).toHaveBeenCalledWith({ userId: 'user_1', limit: 100, offset: 200 });
  });

  it('caps the limit independently from the offset', async () => {
    await route.GET(get('?limit=1000&offset=200'));
    expect(listMock).toHaveBeenCalledWith({ userId: 'user_1', limit: 100, offset: 200 });
  });

  it('caps pathological offsets without breaking deep conversation pages', async () => {
    await route.GET(get(`?limit=100&offset=${MAX_LEGACY_LIST_OFFSET + 1}`));
    expect(listMock).toHaveBeenCalledWith({
      userId: 'user_1',
      limit: 100,
      offset: MAX_LEGACY_LIST_OFFSET,
    });
  });

  it('ignores non-numeric pagination values', async () => {
    await route.GET(get('?limit=abc&offset=-3'));
    expect(listMock).toHaveBeenCalledWith({ userId: 'user_1' });
  });

  it('returns the caller total alongside conversations', async () => {
    listMock.mockResolvedValue(ok({ conversations: [{ id: 'c1' }], total: 3 }));
    const res = await route.GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [{ id: 'c1' }], total: 3 });
  });

  it('propagates domain errors (rate limited use case)', async () => {
    listMock.mockResolvedValue(err(new RateLimitedError('slow down', 1_000)));
    const res = await route.GET(get());
    expect(res.status).toBe(429);
  });
});
