import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sweepMock, requireAdminRouteMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(),
  requireAdminRouteMock: vi.fn(),
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    getComposition: () => ({ sweepStaleQueued: sweepMock }),
    requireAdminRoute: requireAdminRouteMock,
  };
});

import * as route from './route';

const OLD_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  sweepMock.mockReset().mockResolvedValue({ failed: 2 });
  requireAdminRouteMock.mockReset();
});

afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = OLD_SECRET;
});

function req(headers?: Record<string, string>) {
  return new Request('http://localhost/api/admin/queue/sweep', {
    method: 'GET',
    ...(headers === undefined ? {} : { headers }),
  });
}

describe('GET /api/admin/queue/sweep', () => {
  it('authorizes a valid CRON_SECRET bearer without an admin session', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await route.GET(req({ authorization: 'Bearer s3cret' }));
    expect(res.status).toBe(200);
    expect(sweepMock).toHaveBeenCalledOnce();
    expect(requireAdminRouteMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong bearer and falls back to admin session (401 when unauthorized)', async () => {
    process.env.CRON_SECRET = 's3cret';
    requireAdminRouteMock.mockResolvedValue({ ok: false, response: new Response('Unauthorized', { status: 401 }) });
    const res = await route.GET(req({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('falls back to admin session when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    requireAdminRouteMock.mockResolvedValue({ ok: true, session: {}, comp: {} });
    const res = await route.GET(req());
    expect(res.status).toBe(200);
    expect(requireAdminRouteMock).toHaveBeenCalledOnce();
    expect(sweepMock).toHaveBeenCalledOnce();
  });

  it('reports the number of documents swept as failed', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await route.GET(req({ authorization: 'Bearer s3cret' }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, failed: 2 });
  });
});
