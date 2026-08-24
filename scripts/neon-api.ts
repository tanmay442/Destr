export function neonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export function neonApiUrl(projectId: string, path: string): string {
  return `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}${path}`;
}

export async function fetchBranches(
  projectId: string,
  testBranch: string,
  apiKey: string,
): Promise<BranchInfo[]> {
  const headers = neonHeaders(apiKey);
  const list = await fetch(
    neonApiUrl(projectId, `/branches?search=${encodeURIComponent(testBranch)}`),
    { headers },
  );
  if (!list.ok) {
    throw new Error(`Failed to list branches: ${list.status} ${await list.text()}`);
  }
  const { branches } = (await list.json()) as { branches: BranchInfo[] };
  return branches;
}

export interface BranchInfo {
  id: string;
  name: string;
  primary?: boolean;
  created_at?: string;
}

/**
 * Marker encoded on every branch this tooling owns. Teardown refuses to
 * delete a branch without it, so a human/alias branch whose name happens to
 * match a test prefix is never touched.
 */
export const TEST_BRANCH_TAG = '__ragtest__';

/** Full test-owned branch name, e.g. `dev-test__ragtest__`. */
export function makeTestBranchName(base: string): string {
  return `${base}${TEST_BRANCH_TAG}`;
}

export function isTestOwnedBranch(name: string): boolean {
  return name.endsWith(TEST_BRANCH_TAG);
}

/**
 * True when a branch is older than the given TTL. Missing/unparseable timestamps
 * are treated as NOT stale so a branch we cannot date is reused/deleted with
 * default behaviour rather than a surprising recreate.
 */
export function isStaleBranch(
  createdAt: string | undefined,
  ttlMs: number,
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return Date.now() - created > ttlMs;
}

export async function deleteBranch(
  projectId: string,
  branchId: string,
  apiKey: string,
): Promise<void> {
  const res = await fetch(
    neonApiUrl(projectId, `/branches/${encodeURIComponent(branchId)}`),
    { method: 'DELETE', headers: neonHeaders(apiKey) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed to delete branch: ${res.status} ${await res.text()}`,
    );
  }
}

export function isMainModule(): boolean {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}
