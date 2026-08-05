import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

type RateLimitResult = { ok: boolean; remaining?: number; resetMs?: number; retryAfterMs?: number };

const { reingestAllMock, rateLimitMock, isUnauthorized } = vi.hoisted(() => ({
  reingestAllMock: vi.fn(),
  rateLimitMock: vi.fn(async (): Promise<RateLimitResult> => ({ ok: true, remaining: 0, resetMs: 0 })),
  isUnauthorized: { value: false },
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    requireAdminRoute: async () => {
      if (isUnauthorized.value) {
        return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
      }
      return { ok: true, session: { user: { id: 'admin-1' } }, comp: { reingestAll: reingestAllMock, rateLimit: rateLimitMock } };
    },
  };
});

import * as route from './route';

beforeEach(() => {
  reingestAllMock.mockReset();
  rateLimitMock.mockReset().mockResolvedValue({ ok: true, remaining: 0, resetMs: 0 });
  isUnauthorized.value = false;
});

describe('POST /api/admin/reingest', () => {
  it('returns 401 when not authenticated', async () => {
    isUnauthorized.value = true;
    const res = await route.POST(new Request('http://localhost/api/admin/reingest', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(reingestAllMock).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, retryAfterMs: 30_000 });
    const res = await route.POST(new Request('http://localhost/api/admin/reingest', { method: 'POST' }));
    expect(res.status).toBe(429);
    expect(reingestAllMock).not.toHaveBeenCalled();
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('returns 409 when a reingest is already in flight', async () => {
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reingestAllMock.mockReturnValueOnce(
      gate.then(() => ok({ enqueued: 1, documentIds: [1] })),
    );
    const first = route.POST(new Request('http://localhost/api/admin/reingest', { method: 'POST' }));
    const second = await route.POST(new Request('http://localhost/api/admin/reingest', { method: 'POST' }));
    expect(second.status).toBe(409);
    release!();
    await first;
  });

  it('returns the summary on success', async () => {
    reingestAllMock.mockResolvedValue(ok({ enqueued: 4, documentIds: [1, 2, 3, 4] }));
    const res = await route.POST(new Request('http://localhost/api/admin/reingest', { method: 'POST' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ enqueued: 4, documentIds: [1, 2, 3, 4] });
  });
});