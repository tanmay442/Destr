import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appConfig } from '@/lib/config';
import { partialAppConfigSchema } from '@app/domain/app-config';

type FakeRepo = {
  getOverrides: ReturnType<typeof vi.fn>;
  saveOverrides: ReturnType<typeof vi.fn>;
};

function makeRepo(overrides: Record<string, unknown> = {}, version = 0): FakeRepo {
  return {
    getOverrides: vi.fn(async () => ({ overrides, version })),
    saveOverrides: vi.fn(async () => ({ version: version + 1 })),
  };
}

async function loadRuntime(repo: FakeRepo, envLock = '') {
  vi.resetModules();
  if (envLock !== undefined) {
    if (envLock) process.env.APP_SETTINGS_LOCK = envLock;
    else delete process.env.APP_SETTINGS_LOCK;
  }
  vi.doMock('@/composition', () => ({
    getComposition: () => ({ settingsRepo: repo, db: { execute: async () => ({}) } }),
  }));
  return import('@/lib/config/runtime');
}

let nowValue = 1_000_000;
const realNow = Date.now;

beforeEach(() => {
  nowValue = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowValue);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.APP_SETTINGS_LOCK;
  Date.now = realNow;
});

function advance(ms: number) {
  nowValue += ms;
}

describe('getRuntimeConfig precedence', () => {
  it('DB override wins over the file/env default', async () => {
    const repo = makeRepo({ retrievalMode: 'normal' });
    const { getRuntimeConfig } = await loadRuntime(repo);
    const cfg = await getRuntimeConfig();
    expect(cfg.retrievalMode).toBe('normal');
  });

  it('env-lock resets a flat path to the file/env default despite a DB override', async () => {
    const repo = makeRepo({ retrievalMode: 'normal' });
    const { getRuntimeConfig } = await loadRuntime(repo, 'retrievalMode');
    const cfg = await getRuntimeConfig();
    expect(cfg.retrievalMode).toBe(appConfig.retrievalMode);
  });

  it('env-lock resets a nested path to its real default despite a DB override', async () => {
    const repo = makeRepo({ agentPersona: { tone: 'concise' } });
    const { getRuntimeConfig } = await loadRuntime(repo, 'agentPersona.tone');
    const cfg = await getRuntimeConfig();
    expect(cfg.agentPersona.tone).toBe(appConfig.agentPersona.tone);
    expect(cfg.agentPersona.tone).not.toBeUndefined();
  });
});

describe('deepMerge correctness', () => {
  it('merges overrides and keeps unset fields at their defaults', async () => {
    const repo = makeRepo({ similarityThreshold: 0.9 });
    const { getRuntimeConfig } = await loadRuntime(repo);
    const cfg = await getRuntimeConfig();
    expect(cfg.similarityThreshold).toBe(0.9);
    expect(cfg.agentStepBudget).toBe(appConfig.agentStepBudget);
  });

  it('nested object overrides merge rather than replace', async () => {
    const repo = makeRepo({ agentPersona: { tone: 'formal' } });
    const { getRuntimeConfig } = await loadRuntime(repo);
    const cfg = await getRuntimeConfig();
    expect(cfg.agentPersona.tone).toBe('formal');
    expect(cfg.agentPersona.name).toBe(appConfig.agentPersona.name);
  });
});

describe('override validation', () => {
  it('rejects an invalid enum via partialAppConfigSchema', () => {
    const result = partialAppConfigSchema.safeParse({ retrievalMode: 'bogus' as string });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid override when merged and parsed by appConfigSchema', async () => {
    const repo = makeRepo({ retrievalMode: 'bogus' });
    const { getRuntimeConfig } = await loadRuntime(repo);
    const cfg = await getRuntimeConfig();
    expect(cfg.retrievalMode).toBe(appConfig.retrievalMode);
  });
});

describe('SWR caching', () => {
  it('serves from cache on the hot path without re-reading the repo', async () => {
    const repo = makeRepo({});
    const { getRuntimeConfig } = await loadRuntime(repo);
    await getRuntimeConfig();
    advance(5_000);
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
  });

  it('serves stale on the warm path and refreshes once in the background', async () => {
    const repo = makeRepo({ retrievalMode: 'normal' });
    const { getRuntimeConfig } = await loadRuntime(repo);
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
    advance(31_000);
    await getRuntimeConfig();
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(2);
  });

  it('blocks on the cold path then caches', async () => {
    const repo = makeRepo({});
    const { getRuntimeConfig } = await loadRuntime(repo);
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
  });

  it('invalidateRuntimeConfig forces a refresh on next read', async () => {
    const repo = makeRepo({});
    const mod = await loadRuntime(repo);
    await mod.getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
    mod.invalidateRuntimeConfig();
    await mod.getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(2);
  });
});

describe('graceful degradation', () => {
  it('falls back to the static appConfig when the repo always fails (cold)', async () => {
    const repo: FakeRepo = {
      getOverrides: vi.fn(async () => {
        throw new Error('db down');
      }),
      saveOverrides: vi.fn(async () => ({ version: 1 })),
    };
    const { getRuntimeConfig } = await loadRuntime(repo);
    const cfg = await getRuntimeConfig();
    expect(cfg).toEqual(appConfig);
  });

  it('returns last-known-good when a warm refresh fails', async () => {
    const repo = makeRepo({ retrievalMode: 'normal' });
    const { getRuntimeConfig } = await loadRuntime(repo);
    const first = await getRuntimeConfig();
    expect(first.retrievalMode).toBe('normal');
    repo.getOverrides.mockRejectedValueOnce(new Error('db down'));
    advance(31_000);
    const second = await getRuntimeConfig();
    expect(second.retrievalMode).toBe('normal');
  });

  it('seeds a degraded cache on cold-start failure so the DB is not re-queried within the soft window', async () => {
    const repo: FakeRepo = {
      getOverrides: vi.fn(async () => {
        throw new Error('db down');
      }),
      saveOverrides: vi.fn(async () => ({ version: 1 })),
    };
    const { getRuntimeConfig } = await loadRuntime(repo);
    const first = await getRuntimeConfig();
    expect(first).toEqual(appConfig);
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
    advance(10_000);
    const second = await getRuntimeConfig();
    expect(second).toEqual(appConfig);
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
  });

  it('retries the DB after the degraded cache hard-expires', async () => {
    const repo: FakeRepo = {
      getOverrides: vi.fn(async () => {
        throw new Error('db down');
      }),
      saveOverrides: vi.fn(async () => ({ version: 1 })),
    };
    const { getRuntimeConfig } = await loadRuntime(repo);
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(1);
    advance(301_000);
    await getRuntimeConfig();
    expect(repo.getOverrides).toHaveBeenCalledTimes(2);
  });
});
