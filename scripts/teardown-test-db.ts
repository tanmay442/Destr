import 'dotenv/config';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  neonHeaders,
  neonApiUrl,
  fetchBranches,
  isMainModule,
  makeTestBranchName,
  isTestOwnedBranch,
  isStaleBranch,
} from './neon-api';

export async function main() {
  const PROJECT_ID = process.env.NEON_PROJECT_ID;
  const API_KEY = process.env.NEON_API_KEY;
  const BASE_BRANCH = process.env.NEON_TEST_BRANCH ?? 'dev-test';
  const TEST_BRANCH = makeTestBranchName(BASE_BRANCH);
  const TTL_MS =
    Number(process.env.NEON_TEST_BRANCH_TTL_HOURS ?? 24) * 3_600_000;
  const FORCE = process.env.NEON_TEST_BRANCH_FORCE === '1';

  const envPath = resolve(process.cwd(), '.env.test');
  if (existsSync(envPath)) {
    rmSync(envPath, { force: true });
    console.log(`[teardown-test-db] Removed ${envPath}`);
  }

  if (!PROJECT_ID || !API_KEY) {
    console.warn(
      '[teardown-test-db] NEON_PROJECT_ID and NEON_API_KEY are not set; skipping.',
    );
    return;
  }
  const headers = neonHeaders(API_KEY);

  const branches = await fetchBranches(PROJECT_ID, BASE_BRANCH, API_KEY);
  const owned = branches.filter((b) => isTestOwnedBranch(b.name));
  const branch = branches.find((b) => b.name === TEST_BRANCH);
  if (owned.length === 0 && !branch) {
    console.log(`[teardown-test-db] No ${BASE_BRANCH} branch — nothing to do.`);
    return;
  }

  for (const candidate of owned) {
    if (!FORCE && candidate.created_at && !isStaleBranch(candidate.created_at, TTL_MS)) {
      console.log(
        `[teardown-test-db] Branch "${candidate.name}" is younger than TTL ` +
          `(${TTL_MS / 3_600_000}h); skipping deletion so a concurrent run can ` +
          `reuse it. Set NEON_TEST_BRANCH_FORCE=1 to override.`,
      );
      continue;
    }
    const del = await fetch(neonApiUrl(PROJECT_ID, `/branches/${candidate.id}`), {
      method: 'DELETE',
      headers,
    });
    if (!del.ok) {
      throw new Error(
        `Failed to delete branch: ${del.status} ${await del.text()}`,
      );
    }
    console.log(`[teardown-test-db] Deleted branch ${candidate.name} (${candidate.id})`);
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('[teardown-test-db] failed:', err);
    process.exit(1);
  });
}
