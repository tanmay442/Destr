import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROTECTED_EXACT = new Set([
  '.env.local',
  'docs/agent-observability-admin-visibility-spec.md',
  'docs/agentic-tooling-search-modernization-plan.md',
]);

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(JSON.stringify(value));
}

export function fileSha256(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** Fingerprint the complete candidate tree, including non-ignored untracked files. */
export function candidateSourceProvenance(): {
  readonly baseCommit: string;
  readonly sourceTreeSha256: string;
  readonly sourceFileCount: number;
} {
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  ).toString('utf8');
  const paths = listed
    .split('\0')
    .filter(Boolean)
    .filter((path) => !PROTECTED_EXACT.has(path))
    .filter((path) => !path.startsWith('docs/agentic-modernization-agent-logs/'))
    .filter((path) => !/^eval\/wp2-.*-report\.json$/.test(path))
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return {
    baseCommit,
    sourceTreeSha256: `sha256:${hash.digest('hex')}`,
    sourceFileCount: paths.length,
  };
}
