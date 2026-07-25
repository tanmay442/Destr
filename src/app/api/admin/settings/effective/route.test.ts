import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appConfigSchema } from '@app/domain/app-config';

const { state } = vi.hoisted(() => ({
  state: { unauthorized: false, overrides: {} as Record<string, unknown>, locked: [] as string[] },
}));

vi.mock('@/composition', () => ({
  requireAdminRoute: async () => {
    if (state.unauthorized) return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    return {
      ok: true,
      session: { user: { id: 'admin-1' } },
      comp: { settingsRepo: { getOverrides: async () => ({ overrides: state.overrides, version: 0 }) } },
    };
  },
}));

vi.mock('@/lib/config/runtime', () => ({
  getRuntimeConfig: async () => appConfigSchema.parse({ retrievalMode: 'agentic' }),
  envLockedPaths: () => state.locked,
}));

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.overrides = {};
  state.locked = [];
});

describe('GET /api/admin/settings/effective', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('returns resolved values with source annotations', async () => {
    state.overrides = { retrievalMode: 'agentic' };
    state.locked = ['agentStepBudget'];
    const res = await route.GET();
    const json = await res.json();
    expect(json.retrievalMode).toEqual({ value: 'agentic', source: 'db' });
    expect(json.agentStepBudget.source).toBe('env-locked');
    expect(json.embeddingModel.source).toBe('env-locked');
    expect(json.similarityThreshold.source).toBe('default');
  });
});
