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
      comp: {
        settingsRepo: { getOverrides: async () => ({ overrides: state.overrides, version: 0 }) },
        availableRerankers: () =>
          new Map([
            ['cosine', { ok: true }],
            ['cohere', { ok: false, reason: 'COHERE_API_KEY not set' }],
          ]),
      },
    };
  },
}));

vi.mock('@/lib/config/runtime', () => ({
  getRuntimeConfig: async () => appConfigSchema.parse(state.overrides),
  envLockedPaths: () => state.locked,
}));

import * as route from './route';

beforeEach(() => {
  state.unauthorized = false;
  state.overrides = {};
  state.locked = [];
});

describe('GET /api/admin/settings/schema', () => {
  it('returns 401 when not authenticated', async () => {
    state.unauthorized = true;
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('marks env-locked fields readOnly with source env-locked', async () => {
    state.locked = ['retrievalMode'];
    const res = await route.GET();
    const { fields } = await res.json();
    const field = fields.find((f: { key: string }) => f.key === 'retrievalMode');
    expect(field.source).toBe('env-locked');
    expect(field.readOnly).toBe(true);
    expect(field.options).toEqual(['agentic', 'normal']);
  });

  it('marks db-overridden fields with source db', async () => {
    state.overrides = { agentStepBudget: 12 };
    const res = await route.GET();
    const { fields } = await res.json();
    const field = fields.find((f: { key: string }) => f.key === 'agentStepBudget');
    expect(field.source).toBe('db');
    expect(field.current).toBe(12);
  });

  it('reports embeddingModel as readOnly', async () => {
    const res = await route.GET();
    const { fields } = await res.json();
    const field = fields.find((f: { key: string }) => f.key === 'embeddingModel');
    expect(field.readOnly).toBe(true);
  });

  it('flags an unavailable reranker provider', async () => {
    state.overrides = { rerankerProvider: 'cohere' };
    const res = await route.GET();
    const { fields } = await res.json();
    const field = fields.find((f: { key: string }) => f.key === 'rerankerProvider');
    expect(field.available).toBe(false);
    expect(field.unavailableReason).toBe('COHERE_API_KEY not set');
  });

  it('includes every AppConfig field', async () => {
    const res = await route.GET();
    const { fields } = await res.json();
    const keys = new Set(fields.map((f: { key: string }) => f.key));
    expect(keys.has('agentPersona.tone')).toBe(true);
    expect(keys.has('branding.title')).toBe(true);
    expect(keys.has('adminEmails')).toBe(true);
    expect(keys.has('seedDocsDir')).toBe(true);
  });
});
