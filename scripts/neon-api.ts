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
): Promise<Array<{ id: string; name: string; primary?: boolean }>> {
  const headers = neonHeaders(apiKey);
  const list = await fetch(
    neonApiUrl(projectId, `/branches?search=${encodeURIComponent(testBranch)}`),
    { headers },
  );
  if (!list.ok) {
    throw new Error(`Failed to list branches: ${list.status} ${await list.text()}`);
  }
  const { branches } = (await list.json()) as {
    branches: Array<{ id: string; name: string; primary?: boolean }>;
  };
  return branches;
}

export function isMainModule(): boolean {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}
