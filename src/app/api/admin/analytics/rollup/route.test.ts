import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { refreshMock, requireAdminRouteMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  requireAdminRouteMock: vi.fn(),
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    getComposition: () => ({ chatEventBatcher: { refreshDailyStats: refreshMock } }),
    requireAdminRoute: requireAdminRouteMock,
  };
});

import * as route from './route';

const OLD_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  refreshMock.mockReset().mockResolvedValue(undefined);
  requireAdminRouteMock.mockReset();
});

afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = OLD_SECRET;
});

function req(headers?: Record<string, string>) {
  return new Request('http://localhost/api/admin/analytics/rollup', {
    method: 'GET',
    ...(headers === undefined ? {} : { headers }),
  });
}

function postReq() {
  return new Request('http://localhost/api/admin/analytics/rollup', { method: 'POST' });
}

describe('GET /api/admin/analytics/rollup', () => {
  it('authorizes a valid CRON_SECRET bearer without an admin session', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await route.GET(req({ authorization: 'Bearer s3cret' }));
    expect(res.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(requireAdminRouteMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong bearer with 405 and never consults the admin session', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await route.GET(req({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(requireAdminRouteMock).not.toHaveBeenCalled();
  });

  it('rejects GET with 405 when CRON_SECRET is unset (cron-only endpoint)', async () => {
    delete process.env.CRON_SECRET;
    const res = await route.GET(req({ authorization: 'Bearer anything' }));
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(requireAdminRouteMock).not.toHaveBeenCalled();
  });

  it('rejects GET without a bearer with 405 (cron-only endpoint)', async () => {
    delete process.env.CRON_SECRET;
    const res = await route.GET(req());
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/analytics/rollup', () => {
  it('stays admin-only and refreshes for an admin session', async () => {
    requireAdminRouteMock.mockResolvedValue({ ok: true, session: {}, comp: {} });
    const res = await route.POST(postReq());
    expect(res.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it('rejects a non-admin POST with 401', async () => {
    requireAdminRouteMock.mockResolvedValue({ ok: false, response: new Response('Unauthorized', { status: 401 }) });
    const res = await route.POST(postReq());
    expect(res.status).toBe(401);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
