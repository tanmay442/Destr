import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { runtimeConfigOk: true, dbOk: true },
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    getComposition: () => ({
      db: {
        execute: async () => {
          if (!state.dbOk) throw new Error('connection string leaked: postgres://user:pass@host');
        },
      },
    }),
  };
});

vi.mock('@/lib/config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/runtime')>();
  return {
    ...actual,
    getRuntimeConfig: async () => {
      if (!state.runtimeConfigOk) throw new Error('config missing');
    },
  };
});

import * as route from './route';

beforeEach(() => {
  state.runtimeConfigOk = true;
  state.dbOk = true;
});

describe('GET /api/health', () => {
  it('returns 200 healthy when all checks pass', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('healthy');
    expect(json.checks).toEqual({ runtimeConfig: true, database: true });
  });

  it('returns 503 degraded with boolean flags when runtime config fails', async () => {
    state.runtimeConfigOk = false;
    const res = await route.GET();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe('degraded');
    expect(json.checks.runtimeConfig).toBe(false);
  });

  it('returns 503 degraded without leaking error text when the database fails', async () => {
    state.dbOk = false;
    const res = await route.GET();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.checks.database).toBe(false);
    expect(JSON.stringify(json)).not.toContain('connection string');
    expect(JSON.stringify(json)).not.toContain('leaked');
  });
});