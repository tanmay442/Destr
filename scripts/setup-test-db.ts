// Provision a per-run Neon branch, write DATABASE_URL to .env.test, apply
// migrations, and seed. Skips cleanly if NEON_API_KEY is unset (local dev).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { neonHeaders, neonApiUrl, fetchBranches, isMainModule } from './neon-api';

export async function main() {
  const PROJECT_ID = process.env.NEON_PROJECT_ID;
  const API_KEY = process.env.NEON_API_KEY;
  const TEST_BRANCH = process.env.NEON_TEST_BRANCH ?? 'dev-test';
  if (!PROJECT_ID || !API_KEY) {
    console.warn(
      '[setup-test-db] NEON_PROJECT_ID and NEON_API_KEY are not set; skipping branch creation.',
    );
    return;
  }

  const headers = neonHeaders(API_KEY);
  const api = (path: string) => neonApiUrl(PROJECT_ID, path);

  const branches = await fetchBranches(PROJECT_ID, TEST_BRANCH, API_KEY);
  let branch: { id: string; name: string } | undefined =
    branches.find((b) => b.name === TEST_BRANCH);

  if (!branch) {
    const primary = branches.find((b) => b.primary);
    const create = await fetch(api('/branches'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: TEST_BRANCH,
        ...(primary ? { parent_id: primary.id } : {}),
      }),
    });
    if (!create.ok) {
      throw new Error(`Failed to create branch: ${create.status} ${await create.text()}`);
    }
    const created = (await create.json()) as {
      branch: { id: string; name: string; current_state: string };
      operations?: Array<{ id: string; action: string; status: string }>;
    };
    branch = created.branch;
    console.log(`[setup-test-db] Created branch ${branch.name} (${branch.id})`);
    // Wait for branch to leave `init` (create runs async on Neon; acting early
    // returns HTTP 423 "conflicting operations"). Poll 60s max so CI can't hang.
    {
      const deadline = Date.now() + 60_000;
      let state = created.branch.current_state;
      while (state !== 'ready' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await fetch(api(`/branches/${created.branch.id}`), { headers });
        if (poll.ok) {
          const polled = (await poll.json()) as {
            branch: { current_state: string };
          };
          state = polled.branch.current_state;
        }
      }
      if (state !== 'ready') {
        throw new Error(
          `Branch ${created.branch.id} did not become ready in time (state=${state}).`,
        );
      }
    }
  } else {
    console.log(`[setup-test-db] Reusing existing branch ${branch.name} (${branch.id})`);
  }

  if (!branch) {
    throw new Error('Internal error: branch was not assigned.');
  }

  // Ensure a read-write endpoint exists (Neon does not auto-create one on
  // branch creation); reuse if present.
  const endpointsRes = await fetch(api(`/branches/${branch.id}/endpoints`), { headers });
  if (!endpointsRes.ok) {
    throw new Error(
      `Failed to list endpoints: ${endpointsRes.status} ${await endpointsRes.text()}`,
    );
  }
  const { endpoints } = (await endpointsRes.json()) as {
    endpoints: Array<{ id: string; type: string; current_state: string }>;
  };
  let endpoint =
    endpoints.find((e) => e.type === 'read_write') ?? endpoints[0];
  if (!endpoint) {
    // Retry endpoint create on 423 (concurrent ops); the branch-ready wait
    // already covers the create_branch case.
    const createEp = await (async () => {
      const deadline = Date.now() + 60_000;
      let lastErr: Response | undefined;
      while (Date.now() < deadline) {
        const r = await fetch(api('/endpoints'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            endpoint: { branch_id: branch.id, type: 'read_write' },
          }),
        });
        if (r.ok) return r;
        if (r.status === 423) {
          lastErr = r;
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }
        // Non-retryable: surface immediately.
        throw new Error(`Failed to create endpoint: ${r.status} ${await r.text()}`);
      }
      throw new Error(
        `Failed to create endpoint: still 423 after 60s (last=${lastErr ? await lastErr.text() : 'n/a'})`,
      );
    })();
    const created = (await createEp.json()) as {
      endpoint: { id: string; type: string; current_state: string };
    };
    endpoint = created.endpoint;
    console.log(
      `[setup-test-db] Created read_write endpoint ${endpoint.id} (state=${endpoint.current_state})`,
    );
  }

  // Wait for endpoint to become `active` (polls; ~60s cap so CI can't hang).
  const deadline = Date.now() + 60_000;
  while (endpoint.current_state !== 'active' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(api(`/endpoints/${endpoint.id}`), { headers });
    if (!poll.ok) {
      throw new Error(
        `Failed to poll endpoint: ${poll.status} ${await poll.text()}`,
      );
    }
    const polled = (await poll.json()) as { endpoint: { current_state: string } };
    endpoint = { ...endpoint, current_state: polled.endpoint.current_state };
  }
  if (endpoint.current_state !== 'active') {
    throw new Error(
      `Endpoint ${endpoint.id} did not become active in time (state=${endpoint.current_state}).`,
    );
  }

  // Fetch the connection URI for this branch. Neon's API uses /connection_uri
  // (not /connection_string) with role_name + database_name; pin via branch_id
  // (endpoint_id filter rejects branch-only endpoints with 404).
  const conn = await fetch(
    api(
      `/connection_uri?role_name=neondb_owner&database_name=neondb&branch_id=${branch.id}`,
    ),
    { headers },
  );
  if (!conn.ok) {
    throw new Error(`Failed to fetch connection URI: ${conn.status} ${await conn.text()}`);
  }
  const { uri: connectionString } = (await conn.json()) as { uri: string };


  const envPath = resolve(process.cwd(), '.env.test');
  let envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (/^DATABASE_URL=.*$/m.test(envText)) {
    envText = envText.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="${connectionString}"`);
  } else {
    envText += `\nDATABASE_URL="${connectionString}"\n`;
  }
  writeFileSync(envPath, envText, 'utf8');
  console.log(`[setup-test-db] Wrote DATABASE_URL to ${envPath}`);

  // Apply migrations/seed against the *test* branch; override DATABASE_URL
  // since dotenv loaded it pointing at production.
  try {
    execFileSync('node', ['scripts/apply-migration.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: connectionString },
    });
    execFileSync('pnpm', ['db:push', '--force'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: connectionString },
    });
  } catch (err) {
    console.error('[setup-test-db] migration/push failed', err);
    process.exit(1);
  }

  const seed = spawnSync('pnpm', ['seed'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: connectionString },
  });
  if (seed.status !== 0) {
    process.exit(seed.status ?? 1);
  }
  console.log('[setup-test-db] Done');
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('[setup-test-db] failed:', err);
    process.exit(1);
  });
}
