import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
}));

vi.mock('@/composition', () => ({
  requireAdminRoute: async () => {
    if (settingsMock.__unauthorized) {
      return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    }
    return { ok: true, session: {}, comp: {} };
  },
}));

vi.mock('@/lib/config', () => ({
  appConfig: {
    chunkingStrategy: 'document-aware',
    parentChunkSize: 1800,
    childChunkSize: 400,
  },
}));

import * as route from './route';

beforeEach(() => {
  settingsMock.mockReset();
  settingsMock.__unauthorized = false;
  process.env.EMBEDDING_PROVIDER = 'google';
});

describe('GET /api/admin/settings', () => {
  it('returns 401 when not authenticated', async () => {
    settingsMock.__unauthorized = true;
    const res = await route.GET();
    expect(res.status).toBe(401);
  });

  it('returns the current chunking strategy, embedding model, and strategy list', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.chunkingStrategy).toBe('document-aware');
    expect(json.envDriven).toBe(true);
    expect(Array.isArray(json.chunkingStrategies)).toBe(true);
    expect(json.chunkingStrategies).toContain('document-aware');
    expect(json.chunkingStrategies).toContain('parent-child');
    expect(json.embeddingModel).toBe('gemini-embedding-001');
    expect(json.parentChunkSize).toBe(1800);
    expect(json.childChunkSize).toBe(400);
  });
});
