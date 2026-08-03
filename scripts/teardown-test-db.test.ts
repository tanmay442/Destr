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
        branches: [{ id: 'br-1', name: 'dev-test' }],
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
});