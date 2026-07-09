import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: { execFileSync: execFileSyncMock, spawnSync: spawnSyncMock },
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('dotenv/config', () => ({}));

import { main as runSetup } from './setup-test-db';

beforeEach(() => {
  fetchMock.mockReset();
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
});

describe('setup-test-db', () => {
  it('skips cleanly when NEON_API_KEY is not set', async () => {
    const origApiKey = process.env.NEON_API_KEY;
    const origProject = process.env.NEON_PROJECT_ID;
    delete process.env.NEON_API_KEY;
    delete process.env.NEON_PROJECT_ID;
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await runSetup();
      expect(warnSpy).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    } finally {
      if (origApiKey) process.env.NEON_API_KEY = origApiKey;
      if (origProject) process.env.NEON_PROJECT_ID = origProject;
    }
  });

  it('reuses an existing branch and writes DATABASE_URL into .env.test', async () => {
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_API_KEY = 'key-1';
    process.env.NEON_TEST_BRANCH = 'dev-test';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [
          { id: 'br-primary', name: 'production', primary: true },
          { id: 'br-1', name: 'dev-test' },
        ],
      }),
    });
    // Branch already has an active read_write endpoint, so no creation/polling.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        endpoints: [
          { id: 'ep-1', type: 'read_write', current_state: 'active' },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ uri: 'postgres://u:p@host/db?sslmode=require' }),
    });
    execFileSyncMock.mockReturnValueOnce(Buffer.from(''));
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never);

    await runSetup();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['db:push', '--force'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['seed'],
      expect.objectContaining({ env: expect.objectContaining({ DATABASE_URL: expect.stringContaining('postgres://') }) }),
    );
  });

  it('creates a new branch + endpoint when none exist', async () => {
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_API_KEY = 'key-1';
    process.env.NEON_TEST_BRANCH = 'dev-test';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [{ id: 'br-primary', name: 'production', primary: true }],
      }),
    });
    // Create branch returns state=ready, so the wait-for-ready loop is skipped.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branch: { id: 'br-new', name: 'dev-test', current_state: 'ready' },
        operations: [],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ endpoints: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        endpoint: { id: 'ep-new', type: 'read_write', current_state: 'init' },
      }),
    });
    // First poll returns active, so the wait loop exits immediately.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ endpoint: { current_state: 'active' } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ uri: 'postgres://u:p@host/db?sslmode=require' }),
    });
    execFileSyncMock.mockReturnValueOnce(Buffer.from(''));
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never);

    await runSetup();
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toContain('/branches');
    expect(createCall[1]?.method).toBe('POST');
    expect(JSON.parse(createCall[1]?.body as string)).toMatchObject({
      name: 'dev-test',
      parent_id: 'br-primary',
    });
    const epCall = fetchMock.mock.calls[3];
    expect(epCall[0]).toContain('/endpoints');
    expect(epCall[1]?.method).toBe('POST');
    expect(JSON.parse(epCall[1]?.body as string)).toMatchObject({
      endpoint: { branch_id: 'br-new', type: 'read_write' },
    });
    // Assert URI uses branch_id, not endpoint_id (rejected with 404).
    const uriCall = fetchMock.mock.calls[5];
    expect(uriCall[0]).toContain('/connection_uri');
    expect(uriCall[0]).toContain('branch_id=br-new');
    expect(uriCall[0]).toContain('role_name=neondb_owner');
    expect(uriCall[0]).toContain('database_name=neondb');
    expect(uriCall[0]).not.toContain('endpoint_id=');
  });
});
