import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  captureWp0Evidence,
  commandEvidenceSchema,
  repositoryFingerprintSchema,
  WP0_BASE_COMMIT,
  wp0EvidenceSchema,
  type CommandInvocation,
  type CommandRunner,
  type ProcessResult,
  type RepositorySnapshot,
  type RepositorySnapshotReader,
} from './capture-wp0-evidence';

const HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANDIDATE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function goldenReport(mode: 'mock' | 'real_synthetic') {
  return {
    schemaVersion: 'golden-report.v1',
    mode,
    baselineCommit: WP0_BASE_COMMIT,
    candidateModelId: 'fixture-model-v1',
    manifestIdentity: 'synthetic-corpus-v2',
    sourceFingerprint: HASH,
    configFingerprint: HASH,
    corpusFingerprint: HASH,
    dirtyTreeFingerprint: HASH,
    total: 35,
    hits: 27,
    passRate: 1,
    docHitGateActive: true,
    avgFaithfulness: null,
    avgRetrievalRelevance: null,
    meanFaithfulness: 1,
    meanCorrectness: 1,
    meanContextRelevancy: 1,
    threshold: 0.7,
    passed: true,
    generatedAt: '2026-09-05T00:00:00.000Z',
    latency: {
      retrievalMs: { scope: 'all_cases', unit: 'milliseconds', sampleCount: 35, p50: 1, p95: 2, p99: 3 },
      generationMs: { scope: 'all_cases', unit: 'milliseconds', sampleCount: 35, p50: 4, p95: 5, p99: 6 },
      totalMs: { scope: 'all_cases', unit: 'milliseconds', sampleCount: 35, p50: 7, p95: 8, p99: 9 },
    },
    modelUsage: {
      scope: 'all_model_calls',
      unit: 'tokens',
      sampleCount: 0,
      status: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
  };
}

function repositorySnapshot(): RepositorySnapshot {
  return {
    candidateCommit: CANDIDATE_COMMIT,
    sourceFingerprint: HASH,
    configFingerprint: HASH,
    corpusFingerprint: HASH,
    dirtyTreeFingerprint: HASH,
  };
}

function repositoryFingerprints() {
  return {
    sourceFingerprint: HASH,
    configFingerprint: HASH,
    corpusFingerprint: HASH,
    dirtyTreeFingerprint: HASH,
  };
}

function clockFixture(): () => string {
  let tick = 0;
  return () => {
    const value = new Date(Date.UTC(2026, 8, 5, 0, 0, 0, tick));
    tick += 1;
    return value.toISOString();
  };
}

function fixtureRunner(
  rootDirectory: string,
  statuses: Readonly<Record<string, number>> = {},
): { readonly runner: CommandRunner; readonly invocations: CommandInvocation[] } {
  const invocations: CommandInvocation[] = [];
  const runner: CommandRunner = {
    run(invocation): ProcessResult {
      invocations.push(invocation);
      const command = invocation.arguments[0] ?? '';
      const status = statuses[command] ?? 0;
      const output = `safe command output ${command} candidate-secret-not-serialized`;
      if (command === 'eval' && status === 0) {
        const mode = invocation.environment.EVAL_REAL === '1' ? 'real_synthetic' : 'mock';
        mkdirSync(join(invocation.cwd, 'eval'), { recursive: true });
        writeFileSync(
          join(invocation.cwd, 'eval', 'golden-report.json'),
          `${JSON.stringify(goldenReport(mode), null, 2)}\n`,
          'utf8',
        );
      }
      return {
        exitCode: status,
        signal: null,
        stdout: Buffer.from(output, 'utf8'),
        stderr: Buffer.alloc(0),
        spawnError: false,
      };
    },
  };
  void rootDirectory;
  return { runner, invocations };
}

function fixtureRepository(): RepositorySnapshotReader {
  const snapshot = repositorySnapshot();
  return { read: () => snapshot };
}

function withFixture<T>(run: (rootDirectory: string) => T): T {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'wp0-evidence-test-'));
  try {
    return run(rootDirectory);
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
}

describe('WP-0 command evidence producer', () => {
  it('runs the fixed command set, copies both validated reports, and records secret-free hashes', () => {
    withFixture((rootDirectory) => {
      const { runner, invocations } = fixtureRunner(rootDirectory);
      const evidence = captureWp0Evidence({
        rootDirectory,
        runner,
        repository: fixtureRepository(),
        baseWorktree: { create: () => rootDirectory, remove: () => undefined },
        clock: { now: clockFixture() },
      });

      expect(evidence.status).toBe('passed');
      expect(evidence.commands.map((command) => command.name)).toEqual([
        'pre_change_gate',
        'install',
        'candidate_gate',
        'mock_eval',
        'real_synthetic_eval',
        'db_check',
      ]);
      expect(invocations.map((invocation) => [invocation.executable, ...invocation.arguments])).toEqual([
        ['pnpm', 'install', '--frozen-lockfile'],
        ['pnpm', 'gate'],
        ['pnpm', 'install', '--frozen-lockfile'],
        ['pnpm', 'gate'],
        ['pnpm', 'eval'],
        ['pnpm', 'eval', '--trace-model-interactions'],
        ['pnpm', 'db:check'],
      ]);
      expect(readFileSync(join(rootDirectory, 'eval', 'golden-report.mock.json'), 'utf8')).toContain('"mode": "mock"');
      expect(readFileSync(join(rootDirectory, 'eval', 'golden-report.real-synthetic.json'), 'utf8')).toContain('"mode": "real_synthetic"');
      expect(JSON.stringify(evidence)).not.toContain('candidate-secret-not-serialized');

      const mock = evidence.commands.find((command) => command.name === 'mock_eval');
      expect(mock?.outputSha256).toBe(sha256('safe command output eval candidate-secret-not-serialized'));
      expect(mock?.outputByteCount).toBe(Buffer.byteLength('safe command output eval candidate-secret-not-serialized'));
      expect(mock?.artifactCopy?.destinationPath).toBe('eval/golden-report.mock.json');
      expect(mock?.environment.evalReal).toBe('not_set');
      expect(evidence.commands.find((command) => command.name === 'real_synthetic_eval')?.environment).toMatchObject({
        evalReal: '1',
        evalCorpus: 'synthetic',
        evalInterCaseDelayMs: 1000,
      });
      expect(repositoryFingerprintSchema.safeParse(evidence.repository).success).toBe(true);
    });
  });

  it('marks non-zero commands failed while retaining exact process evidence', () => {
    withFixture((rootDirectory) => {
      const { runner } = fixtureRunner(rootDirectory, { gate: 2 });
      const evidence = captureWp0Evidence({
        rootDirectory,
        runner,
        repository: fixtureRepository(),
        baseWorktree: { create: () => rootDirectory, remove: () => undefined },
        clock: { now: clockFixture() },
      });
      const gates = evidence.commands.filter((command) => command.name === 'candidate_gate' || command.name === 'pre_change_gate');
      expect(gates).toHaveLength(2);
      expect(gates.every((command) => command.status === 'failed')).toBe(true);
      expect(gates.every((command) => command.exitCode === 2)).toBe(true);
      expect(gates.every((command) => command.failureCode === 'nonzero_exit')).toBe(true);
      expect(evidence.status).toBe('failed');
    });
  });

  it('rejects duplicate records, inconsistent status, and reversed timestamps at the schema boundary', () => {
    const valid = commandEvidenceSchema.parse({
      name: 'db_check',
      argv: ['pnpm', 'db:check'],
      cwdRole: 'candidate',
      baselineCommit: WP0_BASE_COMMIT,
      repository: repositoryFingerprints(),
      environment: { dotenvConfigPath: 'not_provided', evalReal: 'not_set', evalCorpus: 'not_set' },
      startedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:01.000Z',
      exitCode: 0,
      signal: null,
      status: 'passed',
      failureCode: null,
      stdoutSha256: HASH,
      stderrSha256: HASH,
      outputSha256: HASH,
      stdoutByteCount: 0,
      stderrByteCount: 0,
      outputByteCount: 0,
      artifactCopy: null,
    });
    expect(commandEvidenceSchema.safeParse({ ...valid, completedAt: valid.startedAt }).success).toBe(true);
    expect(commandEvidenceSchema.safeParse({ ...valid, completedAt: '2026-09-04T23:59:59.000Z' }).success).toBe(false);
    expect(commandEvidenceSchema.safeParse({ ...valid, exitCode: 1 }).success).toBe(false);

    const evidence = {
      schemaVersion: 'agent-wp0-command-evidence.v1',
      baselineCommit: WP0_BASE_COMMIT,
      candidateCommit: CANDIDATE_COMMIT,
      generatedAt: '2026-09-05T00:01:00.000Z',
      repository: repositorySnapshot(),
      commands: [valid, valid],
      status: 'passed',
    };
    expect(wp0EvidenceSchema.safeParse(evidence).success).toBe(false);
  });
});
