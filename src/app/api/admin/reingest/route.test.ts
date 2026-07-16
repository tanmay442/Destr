import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@app/domain';

const { reingestAllMock } = vi.hoisted(() => ({
  reingestAllMock: vi.fn(),
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    requireAdminRoute: async () => {
      if (reingestAllMock.__unauthorized) {
        return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
      }
      return { ok: true, session: {}, comp: { reingestAll: reingestAllMock } };
    },
  };
});

import * as route from './route';

beforeEach(() => {
  reingestAllMock.mockReset();
  reingestAllMock.__unauthorized = false;
});

describe('POST /api/admin/reingest', () => {
  it('returns 401 when not authenticated', async () => {
    reingestAllMock.__unauthorized = true;
    const res = await route.POST(
      new Request('http://x/api/admin/reingest', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
    expect(reingestAllMock).not.toHaveBeenCalled();
  });

  it('returns the summary on success', async () => {
    reingestAllMock.mockResolvedValue(ok({ enqueued: 4, documentIds: [1, 2, 3, 4] }));
    const res = await route.POST(
      new Request('http://x/api/admin/reingest', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ enqueued: 4, documentIds: [1, 2, 3, 4] });
  });
});
