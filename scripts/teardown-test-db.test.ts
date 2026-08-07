import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('dotenv/config', () => ({}));

import { main as runTeardown } from './teardown-test-db';

let dir: string;
let origCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teardown-db-'));
  origCwd = process.cwd();
  process.chdir(dir);
  fetchMock.mockReset();
  delete process.env.NEON_API_KEY;
  delete process.env.NEON_PROJECT_ID;
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

const envPath = () => join(process.cwd(), '.env.test');

describe('teardown-test-db', () => {
  it('removes .env.test even when Neon credentials are absent', async () => {
    writeFileSync(envPath(), 'DATABASE_URL="postgres://stale"\n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runTeardown();
    expect(existsSync(envPath())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('deletes the test branch and removes .env.test', async () => {
    writeFileSync(envPath(), 'DATABASE_URL="postgres://stale"\n');
    process.env.NEON_API_KEY = 'key-1';
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_TEST_BRANCH = 'dev-test';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [{ id: 'br-1', name: 'dev-test__ragtest__' }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    });

    await runTeardown();
    const deleteCall = fetchMock.mock.calls[1]!;
    expect(deleteCall[0]).toContain('/branches/br-1');
    expect(deleteCall[1]?.method).toBe('DELETE');
    expect(existsSync(envPath())).toBe(false);
  });

  it('refuses to delete a non-test-owned branch', async () => {
    writeFileSync(envPath(), 'DATABASE_URL="postgres://stale"\n');
    process.env.NEON_API_KEY = 'key-1';
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_TEST_BRANCH = 'dev-test';

    // A human-created branch matching the *base* name but without the tag.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [{ id: 'br-legacy', name: 'dev-test' }],
      }),
    });

    await runTeardown();
    // No DELETE issued; only the list request happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(envPath())).toBe(false);
  });

  it('skips deleting a fresh owned branch unless forced (TTL guard)', async () => {
    process.env.NEON_API_KEY = 'key-1';
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_TEST_BRANCH = 'dev-test';
    process.env.NEON_TEST_BRANCH_TTL_HOURS = '24';
    const fresh = new Date().toISOString();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [{ id: 'br-new', name: 'dev-test__ragtest__', created_at: fresh }],
      }),
    });

    await runTeardown();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Running again with force deletes it.
    process.env.NEON_TEST_BRANCH_FORCE = '1';
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        branches: [{ id: 'br-new', name: 'dev-test__ragtest__', created_at: fresh }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    });
    await runTeardown();
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/branches/br-new');
    delete process.env.NEON_TEST_BRANCH_FORCE;
  });
});