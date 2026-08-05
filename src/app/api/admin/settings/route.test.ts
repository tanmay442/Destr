import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    unauthorized: false,
    overrides: {} as Record<string, unknown>,
    version: 3,
    rerankers: new Map<string, { ok: boolean; reason?: string }>([
      ['cosine', { ok: true }],
      ['cohere', { ok: false, reason: 'COHERE_API_KEY not set' }],
    ]),
    rateOk: true,
    saveResult: { version: 4 } as { version: number } | { conflict: true },
    locked: [] as string[],
    logCalls: [] as unknown[],
    invalidated: 0,
  },
}));

const comp = {
  settingsRepo: {
    getOverrides: async () => ({ overrides: state.overrides, version: state.version }),
    saveOverrides: async () => state.saveResult,
  },
  availableRerankers: () => state.rerankers,
  rateLimit: async () => (state.rateOk ? { ok: true, remaining: 0, resetMs: 0 } : { ok: false, retryAfterMs: 5000 }),
  logSettingsChange: async (input: unknown) => {
    state.logCalls.push(input);
  },
};

vi.mock('@/composition', () => ({
  requireAdminRoute: async () => {
    if (state.unauthorized) return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    return { ok: true, session: { user: { id: 'admin-1' } }, comp };
  },
}));

vi.mock('@/lib/config/runtime', () => ({
  getRuntimeConfig: async () => ({
    retrievalMode: 'agentic',
    agentStepBudget: state.invalidated > 0 ? 5 : 8,
    rerankerProvider: 'cosine',
    agentPersona: { name: 'Astra', tone: 'friendly' },
  }),
  invalidateRuntimeConfig: () => {
    state.invalidated += 1;
  },
  envLockedPaths: () => state.locked,
}));

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.overrides = {};
  state.version = 3;
  state.rateOk = true;
  state.saveResult = { version: 4 };
  state.locked = [];
  state.logCalls = [];
  state.invalidated = 0;
});

function putReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

describe('GET /api/admin/settings', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('returns version, values and source flags', async () => {
    state.overrides = { retrievalMode: 'agentic' };
    const res = await route.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(3);
    expect(json.values.retrievalMode).toBe('agentic');
    expect(json.sources.retrievalMode).toBe('db');
    expect(json.sources.agentStepBudget).toBe('default');
    expect(json.envDriven).toBeUndefined();
  });
});

describe('PUT /api/admin/settings', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.PUT(putReq({ patch: {}, expectedVersion: 3 }));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    state.rateOk = false;
    const res = await route.PUT(putReq({ patch: { agentStepBudget: 5 }, expectedVersion: 3 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it('returns 400 when expectedVersion is missing', async () => {
    const res = await route.PUT(putReq({ patch: { agentStepBudget: 5 } }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on validation failure', async () => {
    const res = await route.PUT(putReq({ patch: { agentStepBudget: -3 }, expectedVersion: 3 }));
    expect(res.status).toBe(400);
  });

  it('returns 422 when patch touches an env-locked field', async () => {
    state.locked = ['retrievalMode'];
    const res = await route.PUT(putReq({ patch: { retrievalMode: 'normal' }, expectedVersion: 3 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.locked).toContain('retrievalMode');
  });

  it('returns 422 when patch touches a read-only field', async () => {
    const res = await route.PUT(putReq({ patch: { adminEmails: ['someone@x.com'] }, expectedVersion: 3 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields).toContain('adminEmails');
  });

  it('returns 422 when the requested reranker is unavailable', async () => {
    const res = await route.PUT(putReq({ patch: { rerankerProvider: 'cohere' }, expectedVersion: 3 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.reason).toBe('COHERE_API_KEY not set');
  });

  it('returns 409 on version conflict', async () => {
    state.saveResult = { conflict: true };
    state.version = 7;
    const res = await route.PUT(putReq({ patch: { agentStepBudget: 5 }, expectedVersion: 3 }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.version).toBe(7);
  });

  it('saves, invalidates cache, logs a settings diff, and returns the new version', async () => {
    const res = await route.PUT(putReq({ patch: { agentStepBudget: 5 }, expectedVersion: 3 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(4);
    expect(state.invalidated).toBe(1);
    expect(state.logCalls).toHaveLength(1);
    expect(state.logCalls[0]).toEqual({
      actorId: 'admin-1',
      changes: [{ key: 'agentStepBudget', old: 8, new: 5 }],
    });
  });
});
