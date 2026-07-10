import 'dotenv/config';
import { neonHeaders, neonApiUrl, fetchBranches, isMainModule } from './neon-api';

export async function main() {
  const PROJECT_ID = process.env.NEON_PROJECT_ID;
  const API_KEY = process.env.NEON_API_KEY;
  const TEST_BRANCH = process.env.NEON_TEST_BRANCH ?? 'dev-test';
  if (!PROJECT_ID || !API_KEY) {
    console.warn(
      '[teardown-test-db] NEON_PROJECT_ID and NEON_API_KEY are not set; skipping.',
    );
    return;
  }
  const headers = neonHeaders(API_KEY);

  const branches = await fetchBranches(PROJECT_ID, TEST_BRANCH, API_KEY);
  const branch = branches.find((b) => b.name === TEST_BRANCH);
  if (!branch) {
    console.log(`[teardown-test-db] No ${TEST_BRANCH} branch — nothing to do.`);
    return;
  }
  const del = await fetch(
    neonApiUrl(PROJECT_ID, `/branches/${branch.id}`),
    { method: 'DELETE', headers },
  );
  if (!del.ok) {
    throw new Error(`Failed to delete branch: ${del.status} ${await del.text()}`);
  }
  console.log(`[teardown-test-db] Deleted branch ${branch.name} (${branch.id})`);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('[teardown-test-db] failed:', err);
    process.exit(1);
  });
}
