import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

/**
 * The commit from which WP-0 was started.  Keeping this value in the producer
 * makes a later invocation continue to compare candidate evidence with the
 * same pre-change state instead of silently moving the baseline.
 */
export const WP0_BASE_COMMIT = 'e22b95119bceba09be0c5b4e0089920b1dc623f2';

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const timestampSchema = z.iso.datetime({ offset: true });

export const commandNameSchema = z.enum([
  'install',
  'pre_change_gate',
  'candidate_gate',
  'mock_eval',
  'real_synthetic_eval',
  'db_check',
]);
export type Wp0CommandName = z.infer<typeof commandNameSchema>;

const cwdRoleSchema = z.enum(['base', 'candidate']);
const commandStatusSchema = z.enum(['passed', 'failed']);
const failureCodeSchema = z.enum([
  'nonzero_exit',
  'terminated_by_signal',
  'spawn_error',
  'missing_artifact',
  'invalid_artifact',
]);

const artifactCopySchema = z.object({
  sourcePath: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u),
  destinationPath: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u),
  sha256: sha256Schema,
  byteCount: z.number().int().nonnegative(),
}).strict();

export const repositoryFingerprintSchema = z.object({
  sourceFingerprint: sha256Schema,
  configFingerprint: sha256Schema,
  corpusFingerprint: sha256Schema,
  dirtyTreeFingerprint: sha256Schema,
}).strict();
export type RepositoryFingerprints = z.infer<typeof repositoryFingerprintSchema>;

const safeEnvironmentSchema = z.object({
  dotenvConfigPath: z.enum(['provided', 'not_provided']),
  evalReal: z.enum(['1', 'not_set']),
  evalCorpus: z.enum(['synthetic', 'not_set']),
  /** Safe numeric pacing metadata; secrets and endpoint values stay absent. */
  evalInterCaseDelayMs: z.number().int().min(0).max(10_000).optional(),
}).strict();

export const commandEvidenceSchema = z.object({
  name: commandNameSchema,
  argv: z.array(z.string().min(1).max(200)).min(1).max(8),
  cwdRole: cwdRoleSchema,
  baselineCommit: commitSchema,
  repository: repositoryFingerprintSchema,
  environment: safeEnvironmentSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  exitCode: z.number().int().nonnegative().nullable(),
  signal: z.string().regex(/^[A-Z0-9]+$/u).nullable(),
  status: commandStatusSchema,
  failureCode: failureCodeSchema.nullable(),
  stdoutSha256: sha256Schema,
  stderrSha256: sha256Schema,
  outputSha256: sha256Schema,
  stdoutByteCount: z.number().int().nonnegative(),
  stderrByteCount: z.number().int().nonnegative(),
  outputByteCount: z.number().int().nonnegative(),
  artifactCopy: artifactCopySchema.nullable(),
}).strict().superRefine((record, context) => {
  const started = Date.parse(record.startedAt);
  const completed = Date.parse(record.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completedAt must be at or after startedAt',
    });
  }

  const expectedPassed = record.exitCode === 0 && record.signal === null && record.failureCode === null;
  if ((record.status === 'passed') !== expectedPassed) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'status and exit/signal/failure fields are inconsistent',
    });
  }
  if (record.status === 'passed' && record.artifactCopy === null &&
      (record.name === 'mock_eval' || record.name === 'real_synthetic_eval')) {
    context.addIssue({
      code: 'custom',
      path: ['artifactCopy'],
      message: 'successful evaluation commands must copy a golden report',
    });
  }
  if (record.outputByteCount !== record.stdoutByteCount + record.stderrByteCount) {
    context.addIssue({
      code: 'custom',
      path: ['outputByteCount'],
      message: 'outputByteCount must equal stdoutByteCount plus stderrByteCount',
    });
  }
});
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

const requiredCommandNames = commandNameSchema.options;

function uniqueCommandEvidence(records: readonly CommandEvidence[]): readonly CommandEvidence[] {
  return commandEvidenceSchema.array().superRefine((items, context) => {
    for (const name of requiredCommandNames) {
      const count = items.filter((item) => item.name === name).length;
      if (count !== 1) {
        context.addIssue({
          code: 'custom',
          message: `expected exactly one ${name} record, found ${count}`,
        });
      }
    }
  }).parse(records);
}

export const wp0EvidenceSchema = z.object({
  schemaVersion: z.literal('agent-wp0-command-evidence.v1'),
  baselineCommit: commitSchema,
  candidateCommit: commitSchema,
  generatedAt: timestampSchema,
  repository: repositoryFingerprintSchema,
  commands: z.array(commandEvidenceSchema),
  status: commandStatusSchema,
}).strict().superRefine((record, context) => {
  try {
    uniqueCommandEvidence(record.commands);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        context.addIssue({
          code: 'custom',
          path: ['commands', ...issue.path],
          message: issue.message,
        });
      }
    } else {
      context.addIssue({ code: 'custom', path: ['commands'], message: 'invalid command evidence' });
    }
  }
  const hasFailure = record.commands.some((command) => command.status === 'failed');
  if ((record.status === 'failed') !== hasFailure) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'overall status must reflect every command status',
    });
  }
  const generated = Date.parse(record.generatedAt);
  if (record.commands.some((command) => Date.parse(command.completedAt) > generated)) {
    context.addIssue({
      code: 'custom',
      path: ['generatedAt'],
      message: 'generatedAt must be at or after every command completion',
    });
  }
});
export type Wp0Evidence = z.infer<typeof wp0EvidenceSchema>;

const goldenLatencyPercentilesSchema = z.object({
  scope: z.literal('all_cases'),
  unit: z.literal('milliseconds'),
  sampleCount: z.number().int().nonnegative(),
  p50: z.number().finite().nonnegative().nullable(),
  p95: z.number().finite().nonnegative().nullable(),
  p99: z.number().finite().nonnegative().nullable(),
}).strict();

export const goldenReportSchema = z.object({
  schemaVersion: z.literal('golden-report.v1'),
  mode: z.enum(['mock', 'real_synthetic', 'real']),
  baselineCommit: commitSchema,
  candidateModelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u),
  manifestIdentity: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u),
  sourceFingerprint: sha256Schema,
  configFingerprint: sha256Schema,
  corpusFingerprint: sha256Schema,
  dirtyTreeFingerprint: sha256Schema,
  total: z.number().int().positive(),
  hits: z.number().int().nonnegative(),
  passRate: z.number().finite().min(0).max(1),
  docHitGateActive: z.boolean(),
  avgFaithfulness: z.number().finite().min(0).max(1).nullable(),
  avgRetrievalRelevance: z.number().finite().min(0).max(1).nullable(),
  meanFaithfulness: z.number().finite().min(0).max(1),
  meanCorrectness: z.number().finite().min(0).max(1),
  meanContextRelevancy: z.number().finite().min(0).max(1),
  threshold: z.number().finite().positive().max(1),
  passed: z.boolean(),
  generatedAt: timestampSchema,
  latency: z.object({
    retrievalMs: goldenLatencyPercentilesSchema,
    generationMs: goldenLatencyPercentilesSchema,
    totalMs: goldenLatencyPercentilesSchema,
  }).strict(),
  modelUsage: z.object({
    scope: z.literal('all_model_calls'),
    unit: z.literal('tokens'),
    sampleCount: z.literal(0),
    status: z.literal('unavailable'),
    inputTokens: z.null(),
    outputTokens: z.null(),
    cacheReadTokens: z.null(),
    cacheWriteTokens: z.null(),
  }).strict(),
}).strict().superRefine((report, context) => {
  if (report.hits > report.total) {
    context.addIssue({ code: 'custom', path: ['hits'], message: 'hits cannot exceed total' });
  }
  for (const [key, latency] of Object.entries(report.latency)) {
    if (
      latency.p50 !== null
      && latency.p95 !== null
      && latency.p99 !== null
      && (latency.p50 > latency.p95 || latency.p95 > latency.p99)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['latency', key],
        message: 'latency percentiles must be monotonic',
      });
    }
  }
  if (report.passed) {
    if (!report.docHitGateActive) {
      context.addIssue({ code: 'custom', path: ['docHitGateActive'], message: 'passing reports require an active document-hit gate' });
    }
    if (report.passRate < 0.8) {
      context.addIssue({ code: 'custom', path: ['passRate'], message: 'passing reports require at least 80% document hits' });
    }
    if (report.meanFaithfulness < report.threshold) {
      context.addIssue({ code: 'custom', path: ['meanFaithfulness'], message: 'passing reports must meet the faithfulness threshold' });
    }
    if (report.avgFaithfulness !== null && report.avgFaithfulness < report.threshold) {
      context.addIssue({ code: 'custom', path: ['avgFaithfulness'], message: 'passing reports must meet the judge faithfulness threshold' });
    }
  }
});
type GoldenReportForCopy = z.infer<typeof goldenReportSchema>;

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly spawnError: boolean;
}

export interface CommandInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  readonly run: (invocation: CommandInvocation) => ProcessResult;
}

const processRunner: CommandRunner = {
  run(invocation) {
    const result = spawnSync(invocation.executable, [...invocation.arguments], {
      cwd: invocation.cwd,
      env: invocation.environment,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      spawnError: result.error !== undefined,
    };
  },
};

export interface RepositorySnapshotReader {
  readonly read: (rootDirectory: string, environment: Readonly<Record<string, string | undefined>>) => RepositorySnapshot;
}

export interface RepositorySnapshot extends RepositoryFingerprints {
  readonly candidateCommit: string;
}

export interface EvidenceFileSystem {
  readonly exists: (path: string) => boolean;
  readonly removeFile: (path: string) => void;
  readonly readFile: (path: string) => Buffer;
  readonly copyFile: (source: string, destination: string) => void;
  readonly makeDirectory: (path: string) => void;
  readonly writeFile: (path: string, content: string) => void;
}

const localFileSystem: EvidenceFileSystem = {
  exists: (path) => existsSync(path),
  removeFile: (path) => unlinkSync(path),
  readFile: (path) => readFileSync(path),
  copyFile: (source, destination) => copyFileSync(source, destination),
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
};

export interface EvidenceClock {
  readonly now: () => string;
}

const systemClock: EvidenceClock = { now: () => new Date().toISOString() };

interface FixedCommand {
  readonly name: Wp0CommandName;
  readonly arguments: readonly string[];
  readonly cwdRole: z.infer<typeof cwdRoleSchema>;
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly reportMode: 'mock' | 'real_synthetic' | null;
  readonly reportDestination: string | null;
}

const fixedCandidateCommands: readonly FixedCommand[] = [
  {
    name: 'install',
    arguments: ['install', '--frozen-lockfile'],
    cwdRole: 'candidate',
    environmentOverrides: {},
    reportMode: null,
    reportDestination: null,
  },
  {
    name: 'candidate_gate',
    arguments: ['gate'],
    cwdRole: 'candidate',
    environmentOverrides: {},
    reportMode: null,
    reportDestination: null,
  },
  {
    name: 'mock_eval',
    arguments: ['eval'],
    cwdRole: 'candidate',
    environmentOverrides: {},
    reportMode: 'mock',
    reportDestination: 'eval/golden-report.mock.json',
  },
  {
    name: 'real_synthetic_eval',
    arguments: ['eval', '--trace-model-interactions'],
    cwdRole: 'candidate',
    environmentOverrides: {
      EVAL_REAL: '1',
      EVAL_CORPUS: 'synthetic',
      EVAL_INTER_CASE_DELAY_MS: '1000',
    },
    reportMode: 'real_synthetic',
    reportDestination: 'eval/golden-report.real-synthetic.json',
  },
  {
    name: 'db_check',
    arguments: ['db:check'],
    cwdRole: 'candidate',
    environmentOverrides: {},
    reportMode: null,
    reportDestination: null,
  },
];

const baseGateCommand: FixedCommand = {
  name: 'pre_change_gate',
  arguments: ['gate'],
  cwdRole: 'base',
  environmentOverrides: {},
  reportMode: null,
  reportDestination: null,
};

export interface CaptureWp0EvidenceOptions {
  readonly rootDirectory?: string;
  readonly baselineCommit?: string;
  readonly runner?: CommandRunner;
  readonly repository?: RepositorySnapshotReader;
  readonly fileSystem?: EvidenceFileSystem;
  readonly clock?: EvidenceClock;
  readonly baseWorktree?: BaseWorktreeManager;
  readonly evidencePath?: string;
  readonly onProgress?: (event: EvidenceProgressEvent) => void;
}

export type EvidenceProgressEvent =
  | { readonly kind: 'command_started'; readonly index: number; readonly count: number; readonly name: string }
  | { readonly kind: 'command_completed'; readonly index: number; readonly count: number; readonly name: string; readonly status: 'passed' | 'failed'; readonly elapsedMs: number };

function prefixedSha256Bytes(content: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(content);
  return `sha256:${hash.digest('hex')}`;
}

function prefixedSha256Parts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

function runGitText(rootDirectory: string, arguments_: readonly string[]): string {
  const result = spawnSync('git', [...arguments_], {
    cwd: rootDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('git provenance command failed');
  }
  return result.stdout.trim();
}

function runGitBytes(rootDirectory: string, arguments_: readonly string[]): Buffer {
  const result = spawnSync('git', [...arguments_], {
    cwd: rootDirectory,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('git provenance command failed');
  }
  return result.stdout;
}

function hashFileOrMarker(rootDirectory: string, path: string): string {
  const absolutePath = resolve(rootDirectory, path);
  try {
    return prefixedSha256Bytes(readFileSync(absolutePath));
  } catch {
    return prefixedSha256Parts([`missing:${path}`]);
  }
}

const configurationPaths: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.env.example',
  'config/app.config.ts',
  'packages/infrastructure/src/config/database.ts',
  'packages/infrastructure/src/config/env.ts',
  'scripts/eval/run.ts',
];

const corpusPaths: readonly string[] = [
  'scripts/eval/mock-corpus.ts',
  'scripts/eval/golden.ts',
  'scripts/eval/agent-baseline-cases.ts',
];

const safeEnvironmentKeys: readonly string[] = [
  'CHAT_PROVIDER',
  'EVAL_CORPUS',
  'EVAL_MODEL_ID',
  'EVAL_INTER_CASE_DELAY_MS',
  'LLM_MODEL',
  'GOOGLE_CHAT_MODEL',
  'OLLAMA_CHAT_MODEL',
  'RERANKER_PROVIDER',
  'AGENTIC_ENABLED',
];

const sensitiveEnvironmentKeys: readonly string[] = [
  'AI_STUDIO_KEY',
  'COHERE_API_KEY',
  'CUSTOM_LLM_API_KEY',
  'CUSTOM_LLM_BASE_URL',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'OLLAMA_BASE_URL',
  'OPENAI_EMBEDDING_API_KEY',
  'OPENAI_EMBEDDING_BASE_URL',
  'QSTASH_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'VERCEL_OIDC_TOKEN',
];

function untrackedFileFingerprint(rootDirectory: string): string {
  const listing = runGitBytes(rootDirectory, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listing.toString('utf8').split('\u0000').filter((path) => path.length > 0).sort();
  const entries = paths.map((path) => `${path}:${runGitText(rootDirectory, ['hash-object', '--no-filters', '--', path])}`);
  return prefixedSha256Parts(['untracked-files.v1', ...entries]);
}

function readRepositorySnapshot(
  rootDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): RepositorySnapshot {
  const trackedIndex = runGitText(rootDirectory, ['ls-files', '-s']);
  const stagedDiff = runGitText(rootDirectory, ['diff', '--cached', '--binary', '--no-ext-diff', '--']);
  const worktreeDiff = runGitText(rootDirectory, ['diff', '--binary', '--no-ext-diff', '--']);
  const status = runGitText(rootDirectory, ['status', '--porcelain=v1', '--untracked-files=all']);
  const untracked = untrackedFileFingerprint(rootDirectory);
  const candidateCommit = runGitText(rootDirectory, ['rev-parse', 'HEAD']);
  const sourceFingerprint = prefixedSha256Parts([
    'source.v1', trackedIndex, stagedDiff, worktreeDiff, untracked,
  ]);
  const configParts = configurationPaths.map((path) => `${path}:${hashFileOrMarker(rootDirectory, path)}`);
  const safeEnvironmentParts = safeEnvironmentKeys.map((key) => `${key}=${environment[key]?.trim() ?? '<unset>'}`);
  const sensitivePresence = sensitiveEnvironmentKeys.map((key) => `${key}=${environment[key]?.trim() ? 'present' : 'unset'}`);
  const configFingerprint = prefixedSha256Parts([
    'config.v1', ...configParts, ...safeEnvironmentParts, ...sensitivePresence,
  ]);
  const corpusFingerprint = prefixedSha256Parts([
    'corpus.v1', ...corpusPaths.map((path) => `${path}:${hashFileOrMarker(rootDirectory, path)}`),
  ]);
  const dirtyTreeFingerprint = prefixedSha256Parts([
    'dirty-tree.v1', status, stagedDiff, worktreeDiff, untracked,
  ]);
  return {
    candidateCommit,
    sourceFingerprint,
    configFingerprint,
    corpusFingerprint,
    dirtyTreeFingerprint,
  };
}

function safeEnvironment(environment: NodeJS.ProcessEnv): z.infer<typeof safeEnvironmentSchema> {
  const rawDelay = environment.EVAL_INTER_CASE_DELAY_MS?.trim();
  const parsedDelay = rawDelay === undefined || rawDelay === '' ? undefined : Number(rawDelay);
  const evalInterCaseDelayMs =
    parsedDelay !== undefined
    && Number.isInteger(parsedDelay)
    && parsedDelay >= 0
    && parsedDelay <= 10_000
      ? parsedDelay
      : undefined;
  return {
    dotenvConfigPath: environment.DOTENV_CONFIG_PATH?.trim() ? 'provided' : 'not_provided',
    evalReal: environment.EVAL_REAL === '1' ? '1' : 'not_set',
    evalCorpus: environment.EVAL_CORPUS?.trim().toLowerCase() === 'synthetic' ? 'synthetic' : 'not_set',
    ...(evalInterCaseDelayMs === undefined ? {} : { evalInterCaseDelayMs }),
  };
}

function childEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    environment[key] = value;
  }
  return environment;
}

function processFailureCode(result: ProcessResult): z.infer<typeof failureCodeSchema> | null {
  if (result.exitCode === 0 && result.signal === null && !result.spawnError) return null;
  if (result.spawnError) return 'spawn_error';
  if (result.signal !== null) return 'terminated_by_signal';
  return 'nonzero_exit';
}

function repositoryFingerprints(snapshot: RepositorySnapshot): RepositoryFingerprints {
  return {
    sourceFingerprint: snapshot.sourceFingerprint,
    configFingerprint: snapshot.configFingerprint,
    corpusFingerprint: snapshot.corpusFingerprint,
    dirtyTreeFingerprint: snapshot.dirtyTreeFingerprint,
  };
}

function commandEvidence(
  command: FixedCommand,
  result: ProcessResult,
  startedAt: string,
  completedAt: string,
  baselineCommit: string,
  repository: RepositoryFingerprints,
  environment: NodeJS.ProcessEnv,
  artifactCopy: z.infer<typeof artifactCopySchema> | null,
  failureCodeOverride: z.infer<typeof failureCodeSchema> | null = null,
): CommandEvidence {
  const output = Buffer.concat([result.stdout, result.stderr]);
  const failureCode = processFailureCode(result) ?? failureCodeOverride;
  const record = {
    name: command.name,
    argv: ['pnpm', ...command.arguments],
    cwdRole: command.cwdRole,
    baselineCommit,
    repository,
    environment: safeEnvironment(environment),
    startedAt,
    completedAt,
    exitCode: result.exitCode,
    signal: result.signal,
    status: failureCode === null ? 'passed' : 'failed',
    failureCode,
    stdoutSha256: prefixedSha256Bytes(result.stdout),
    stderrSha256: prefixedSha256Bytes(result.stderr),
    outputSha256: prefixedSha256Bytes(output),
    stdoutByteCount: result.stdout.byteLength,
    stderrByteCount: result.stderr.byteLength,
    outputByteCount: output.byteLength,
    artifactCopy,
  } satisfies z.input<typeof commandEvidenceSchema>;
  return commandEvidenceSchema.parse(record);
}

function validateRelativePath(rootDirectory: string, path: string): string {
  if (isAbsolute(path)) throw new Error('evidence artifact path must be relative');
  const resolvedPath = resolve(rootDirectory, path);
  const relativePath = relative(rootDirectory, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('evidence artifact path escapes the repository');
  }
  return resolvedPath;
}

function copyGoldenReport(
  rootDirectory: string,
  command: FixedCommand,
  baselineCommit: string,
  fileSystem: EvidenceFileSystem,
): z.infer<typeof artifactCopySchema> {
  if (command.reportMode === null || command.reportDestination === null) {
    throw new Error('command does not have a golden report destination');
  }
  const sourcePath = 'eval/golden-report.json';
  const sourceAbsolutePath = validateRelativePath(rootDirectory, sourcePath);
  const destinationAbsolutePath = validateRelativePath(rootDirectory, command.reportDestination);
  if (!fileSystem.exists(sourceAbsolutePath)) throw new Error('golden report is missing');
  const sourceContent = fileSystem.readFile(sourceAbsolutePath);
  let parsed: GoldenReportForCopy;
  try {
    const value: unknown = JSON.parse(sourceContent.toString('utf8'));
    parsed = goldenReportSchema.parse(value);
  } catch {
    throw new Error('golden report failed schema validation');
  }
  if (parsed.mode !== command.reportMode) throw new Error('golden report mode does not match the fixed command');
  if (parsed.baselineCommit !== baselineCommit) throw new Error('golden report baseline commit does not match WP-0');
  fileSystem.makeDirectory(dirname(destinationAbsolutePath));
  fileSystem.copyFile(sourceAbsolutePath, destinationAbsolutePath);
  const copiedContent = fileSystem.readFile(destinationAbsolutePath);
  if (!copiedContent.equals(sourceContent)) throw new Error('golden report copy changed its content');
  return artifactCopySchema.parse({
    sourcePath,
    destinationPath: command.reportDestination,
    sha256: prefixedSha256Bytes(copiedContent),
    byteCount: copiedContent.byteLength,
  });
}

function removeStaleReport(rootDirectory: string, fileSystem: EvidenceFileSystem): void {
  const path = validateRelativePath(rootDirectory, 'eval/golden-report.json');
  if (fileSystem.exists(path)) fileSystem.removeFile(path);
}

function runCommand(
  command: FixedCommand,
  cwd: string,
  baselineCommit: string,
  runner: CommandRunner,
  repository: RepositorySnapshotReader,
  fileSystem: EvidenceFileSystem,
  clock: EvidenceClock,
): CommandEvidence {
  if (command.reportMode !== null) removeStaleReport(cwd, fileSystem);
  const startedAt = clock.now();
  const environment = childEnvironment(command.environmentOverrides);
  const result = runner.run({
    executable: 'pnpm',
    arguments: command.arguments,
    cwd,
    environment,
  });
  const completedAt = clock.now();
  const snapshot = repository.read(cwd, environment);
  let artifactCopy: z.infer<typeof artifactCopySchema> | null = null;
  let artifactFailureCode: z.infer<typeof failureCodeSchema> | null = null;
  if (command.reportMode !== null && result.exitCode === 0 && result.signal === null && !result.spawnError) {
    try {
      artifactCopy = copyGoldenReport(cwd, command, baselineCommit, fileSystem);
    } catch {
      // A successful process without a fresh, validated report is not evidence
      // of a successful evaluation. Preserve the process exit status while
      // recording the artifact failure as a separate typed disposition.
      artifactFailureCode = 'invalid_artifact';
    }
  }
  const processCode = processFailureCode(result);
  const record = commandEvidence(
    command,
    result,
    startedAt,
    completedAt,
    baselineCommit,
    repositoryFingerprints(snapshot),
    environment,
    artifactCopy,
    processCode ?? artifactFailureCode,
  );
  return record;
}

function createBaseWorktree(
  rootDirectory: string,
  baselineCommit: string,
  runner: CommandRunner,
): string {
  const worktree = mkdtempSync(join(tmpdir(), 'agent-wp0-base-'));
  const result = runner.run({
    executable: 'git',
    arguments: ['worktree', 'add', '--detach', worktree, baselineCommit],
    cwd: rootDirectory,
    environment: childEnvironment({}),
  });
  if (result.exitCode !== 0 || result.signal !== null || result.spawnError) {
    rmSync(worktree, { recursive: true, force: true });
    throw new Error('could not create the temporary base worktree');
  }
  return worktree;
}

function removeBaseWorktree(rootDirectory: string, worktree: string, runner: CommandRunner): void {
  const result = runner.run({
    executable: 'git',
    arguments: ['worktree', 'remove', '--force', worktree],
    cwd: rootDirectory,
    environment: childEnvironment({}),
  });
  if (result.exitCode !== 0 || result.signal !== null || result.spawnError) {
    rmSync(worktree, { recursive: true, force: true });
  }
}

export interface BaseWorktreeManager {
  readonly create: (rootDirectory: string, baselineCommit: string, runner: CommandRunner) => string;
  readonly remove: (rootDirectory: string, worktree: string, runner: CommandRunner) => void;
}

const localBaseWorktree: BaseWorktreeManager = {
  create: createBaseWorktree,
  remove: removeBaseWorktree,
};

function ensureBaselineCommit(value: string): string {
  return commitSchema.parse(value);
}

export function captureWp0Evidence(options: CaptureWp0EvidenceOptions = {}): Wp0Evidence {
  const rootDirectory = resolve(options.rootDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const baselineCommit = ensureBaselineCommit(options.baselineCommit ?? WP0_BASE_COMMIT);
  const runner = options.runner ?? processRunner;
  const repository = options.repository ?? { read: readRepositorySnapshot } satisfies RepositorySnapshotReader;
  const fileSystem = options.fileSystem ?? localFileSystem;
  const clock = options.clock ?? systemClock;
  const baseWorktreeManager = options.baseWorktree ?? localBaseWorktree;
  const candidateEnvironment = childEnvironment({});
  const records: CommandEvidence[] = [];
  const commandCount = requiredCommandNames.length + 1;
  let commandIndex = 0;
  const runWithProgress = (command: FixedCommand, cwd: string): CommandEvidence => {
    commandIndex += 1;
    options.onProgress?.({
      kind: 'command_started',
      index: commandIndex,
      count: commandCount,
      name: command.name,
    });
    const record = runCommand(
      command,
      cwd,
      baselineCommit,
      runner,
      repository,
      fileSystem,
      clock,
    );
    options.onProgress?.({
      kind: 'command_completed',
      index: commandIndex,
      count: commandCount,
      name: command.name,
      status: record.status,
      elapsedMs: Date.parse(record.completedAt) - Date.parse(record.startedAt),
    });
    return record;
  };

  const baseWorktree = baseWorktreeManager.create(rootDirectory, baselineCommit, runner);
  try {
    commandIndex += 1;
    options.onProgress?.({ kind: 'command_started', index: commandIndex, count: commandCount, name: 'base_install' });
    const baseInstallStartedAt = Date.now();
    const setup = runner.run({
      executable: 'pnpm',
      arguments: ['install', '--frozen-lockfile'],
      cwd: baseWorktree,
      environment: childEnvironment({}),
    });
    if (setup.exitCode !== 0 || setup.signal !== null || setup.spawnError) {
      options.onProgress?.({ kind: 'command_completed', index: commandIndex, count: commandCount, name: 'base_install', status: 'failed', elapsedMs: Date.now() - baseInstallStartedAt });
      throw new Error('base worktree dependency installation failed');
    }
    options.onProgress?.({ kind: 'command_completed', index: commandIndex, count: commandCount, name: 'base_install', status: 'passed', elapsedMs: Date.now() - baseInstallStartedAt });
    records.push(runWithProgress(baseGateCommand, baseWorktree));
  } finally {
    baseWorktreeManager.remove(rootDirectory, baseWorktree, runner);
  }

  for (const command of fixedCandidateCommands) {
    records.push(runWithProgress(command, rootDirectory));
  }

  const generatedAt = clock.now();
  const finalSnapshot = repository.read(rootDirectory, candidateEnvironment);
  const status = records.every((record) => record.status === 'passed') ? 'passed' : 'failed';
  const evidence = {
    schemaVersion: 'agent-wp0-command-evidence.v1',
    baselineCommit,
    candidateCommit: finalSnapshot.candidateCommit,
    generatedAt,
    repository: repositoryFingerprints(finalSnapshot),
    commands: records,
    status,
  } satisfies z.input<typeof wp0EvidenceSchema>;
  return wp0EvidenceSchema.parse(evidence);
}

export function writeWp0Evidence(
  evidence: Wp0Evidence,
  rootDirectory: string,
  fileSystem: EvidenceFileSystem = localFileSystem,
  evidencePath = 'eval/wp0-command-evidence.json',
): string {
  const destination = validateRelativePath(rootDirectory, evidencePath);
  fileSystem.makeDirectory(dirname(destination));
  fileSystem.writeFile(destination, `${JSON.stringify(wp0EvidenceSchema.parse(evidence), null, 2)}\n`);
  return destination;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  if (process.argv.length > 2) {
    console.error('[wp0-evidence] fixed producer accepts no command arguments');
    process.exitCode = 2;
  } else {
    try {
      const evidence = captureWp0Evidence({
        onProgress: (event) => {
          if (event.kind === 'command_started') {
            console.log(`[wp0-evidence] progress command=${event.index}/${event.count} name=${event.name} status=started`);
          } else {
            console.log(`[wp0-evidence] progress command=${event.index}/${event.count} name=${event.name} status=${event.status} elapsedMs=${event.elapsedMs}`);
          }
        },
      });
      const path = writeWp0Evidence(evidence, resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
      console.log(`[wp0-evidence] ${evidence.status}; report written to ${path}`);
      if (evidence.status === 'failed') process.exitCode = 1;
    } catch {
      console.error('[wp0-evidence] capture failed closed; no secret-bearing command output was emitted');
      process.exitCode = 1;
    }
  }
}
