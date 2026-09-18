/**
 * Safe distributed-load operator command (WP-8, F-41, §13.6).
 *
 * Usage:
 *   pnpm load:agent --profile=average-4k --target=<approved-environment>
 *     --identity=loadtest-<name> --duration-s=<n> --cost-ceiling-usd=<amount>
 *     --report=<path> [--execute] [--method=GET] [--path=/api/health]
 *     [--max-connections=<n>] [--abort-shed-rate=<0..1>]
 *   pnpm load:agent --profile=peak-20k --target=<approved-environment>
 *     --confirm-cost-cap=<amount> [...same required flags...]
 *
 * Safety contract (no exceptions):
 * - Production-like targets are ALWAYS refused (no override flag exists).
 * - Unknown targets (not in LOAD_AGENT_ALLOWED_TARGETS) are refused.
 * - --profile, --target, --identity, --duration-s, --cost-ceiling-usd, and
 *   --report are all required; the command never runs an unbounded load.
 * - Identities must be isolated (`loadtest-` prefix) so load traffic can
 *   never masquerade as real users or tenants.
 * - peak-20k additionally requires LOAD_AGENT_PEAK_APPROVAL=1 in the
 *   environment plus a matching --confirm-cost-cap (separate authorization).
 * - Without --execute the command only writes a dry-run plan (no traffic).
 * - With --execute it runs a bounded, abortable HTTPS load with live shed
 *   detection (abort when the shed rate exceeds --abort-shed-rate) and always
 *   writes a machine-readable report, including on refusal (exit 2) and on
 *   abort.
 *
 * Real 4k/20k results remain UNVERIFIED until the authorized non-production
 * runs documented in docs/runtime/capacity-model.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export const LOAD_AGENT_VERSION = 'load-agent.v1';
export const MAX_DURATION_S = 2_100;
export const MIN_DURATION_S = 30;
export const PEAK_APPROVAL_ENV = 'LOAD_AGENT_PEAK_APPROVAL';
export const ALLOWED_TARGETS_ENV = 'LOAD_AGENT_ALLOWED_TARGETS';
const PRODUCTION_PATTERN = /(^|[.-])(prod|production|live)([.-]|$)/i;
const IDENTITY_PATTERN = /^loadtest-[a-z0-9-]{1,64}$/;

export type LoadProfile = 'average-4k' | 'peak-20k';

export const LOAD_PROFILES: Readonly<Record<LoadProfile, { activeTurns: number; requiresPeakApproval: boolean }>> = Object.freeze({
  'average-4k': Object.freeze({ activeTurns: 4_000, requiresPeakApproval: false }),
  'peak-20k': Object.freeze({ activeTurns: 20_000, requiresPeakApproval: true }),
});

export interface ParsedLoadAgentArgs {
  readonly profile: LoadProfile;
  readonly target: string;
  readonly identity: string;
  readonly durationS: number;
  readonly costCeilingUsd: number;
  readonly confirmCostCap: number | null;
  readonly report: string;
  readonly execute: boolean;
  readonly method: string;
  readonly path: string;
  readonly maxConnections: number;
  readonly abortShedRate: number;
}

export class LoadAgentUsageError extends Error {
  readonly code = 'load_agent_usage_error';
  constructor(message: string) {
    super(message);
    this.name = 'LoadAgentUsageError';
  }
}

function requireFlag(args: Map<string, string | null>, name: string): string {
  const value = args.get(name);
  if (value === null || value === undefined || value === '') {
    throw new LoadAgentUsageError(`missing required --${name}`);
  }
  return value;
}

export function parseLoadAgentArgs(argv: readonly string[]): ParsedLoadAgentArgs {
  const flags = new Map<string, string | null>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new LoadAgentUsageError(`unexpected argument "${arg}"; expected --flag=value`);
    const withoutDashes = arg.slice(2);
    const equalsAt = withoutDashes.indexOf('=');
    if (equalsAt < 0) {
      flags.set(withoutDashes, null);
    } else {
      flags.set(withoutDashes.slice(0, equalsAt), withoutDashes.slice(equalsAt + 1));
    }
  }
  const profileRaw = requireFlag(flags, 'profile');
  if (profileRaw !== 'average-4k' && profileRaw !== 'peak-20k') {
    throw new LoadAgentUsageError(`--profile must be average-4k|peak-20k, received "${profileRaw}"`);
  }
  const durationRaw = requireFlag(flags, 'duration-s');
  const durationS = Number(durationRaw);
  if (!Number.isFinite(durationS) || durationS < MIN_DURATION_S || durationS > MAX_DURATION_S) {
    throw new LoadAgentUsageError(`--duration-s must be bounded [${MIN_DURATION_S},${MAX_DURATION_S}], received "${durationRaw}"`);
  }
  const ceilingRaw = requireFlag(flags, 'cost-ceiling-usd');
  const costCeilingUsd = Number(ceilingRaw);
  if (!Number.isFinite(costCeilingUsd) || costCeilingUsd <= 0) {
    throw new LoadAgentUsageError(`--cost-ceiling-usd must be a positive amount, received "${ceilingRaw}"`);
  }
  const confirmRaw = flags.get('confirm-cost-cap') ?? null;
  const confirmCostCap = confirmRaw === null || confirmRaw === '' ? null : Number(confirmRaw);
  if (confirmRaw !== null && confirmRaw !== '' && (!Number.isFinite(confirmCostCap) || (confirmCostCap as number) <= 0)) {
    throw new LoadAgentUsageError(`--confirm-cost-cap must be a positive amount, received "${confirmRaw}"`);
  }
  const maxConnectionsRaw = flags.get('max-connections') ?? '200';
  const maxConnections = Number(maxConnectionsRaw);
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 2_000) {
    throw new LoadAgentUsageError(`--max-connections must be an integer in [1,2000], received "${maxConnectionsRaw}"`);
  }
  const abortRaw = flags.get('abort-shed-rate') ?? '0.5';
  const abortShedRate = Number(abortRaw);
  if (!Number.isFinite(abortShedRate) || abortShedRate < 0 || abortShedRate > 1) {
    throw new LoadAgentUsageError(`--abort-shed-rate must be in [0,1], received "${abortRaw}"`);
  }
  const method = (flags.get('method') ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new LoadAgentUsageError(`--method must be GET|POST, received "${method}"`);
  }
  const path = flags.get('path') ?? '/api/health';
  if (!path.startsWith('/')) throw new LoadAgentUsageError(`--path must start with /, received "${path}"`);
  return {
    profile: profileRaw,
    target: requireFlag(flags, 'target'),
    identity: requireFlag(flags, 'identity'),
    durationS: Math.floor(durationS),
    costCeilingUsd,
    confirmCostCap,
    report: requireFlag(flags, 'report'),
    execute: flags.has('execute'),
    method,
    path,
    maxConnections,
    abortShedRate,
  };
}

export type AuthorizeResult =
  | { readonly allowed: true; readonly plan: LoadPlan }
  | { readonly allowed: false; readonly reasons: readonly string[] };

export interface LoadPlan {
  readonly profile: LoadProfile;
  readonly activeTurns: number;
  readonly target: string;
  readonly identity: string;
  readonly durationS: number;
  readonly costCeilingUsd: number;
  readonly method: string;
  readonly path: string;
  readonly maxConnections: number;
  readonly abortShedRate: number;
}

export function allowedTargets(env: { readonly [key: string]: string | undefined }): readonly string[] {
  const raw = env[ALLOWED_TARGETS_ENV] ?? '';
  return Object.freeze(raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

export function isProductionLike(target: string): boolean {
  // Match against the URL hostname when the target parses as a URL: testing
  // the raw string misses standard hosts because the scheme's "//" precedes
  // the hostname (e.g. "https://prod.example.com" has "/prod", not ".prod").
  try {
    const hostname = new URL(target).hostname;
    if (PRODUCTION_PATTERN.test(hostname)) return true;
  } catch {
    // Fall through to the raw-target check below.
  }
  return PRODUCTION_PATTERN.test(target);
}

export function authorizeLoad(
  args: ParsedLoadAgentArgs,
  env: { readonly [key: string]: string | undefined },
): AuthorizeResult {
  const reasons: string[] = [];
  if (isProductionLike(args.target)) {
    reasons.push(`target "${args.target}" looks like production; production load is never authorized by this tool`);
  }
  if (!allowedTargets(env).includes(args.target)) {
    reasons.push(`target "${args.target}" is not in ${ALLOWED_TARGETS_ENV}; unknown targets are refused by default`);
  }
  if (!IDENTITY_PATTERN.test(args.identity)) {
    reasons.push(`identity "${args.identity}" is not isolated; use a loadtest- prefixed identity (e.g. loadtest-peak-a)`);
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(args.target);
  } catch {
    reasons.push(`target "${args.target}" is not a valid URL`);
  }
  if (parsedUrl !== null) {
    const isLoopback = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1';
    if (parsedUrl.protocol !== 'https:' && !isLoopback) {
      reasons.push(`target "${args.target}" must use https (http is allowed only for loopback harnesses)`);
    }
  }
  const profile = LOAD_PROFILES[args.profile];
  if (profile.requiresPeakApproval) {
    if (env[PEAK_APPROVAL_ENV] !== '1') {
      reasons.push(`peak-20k requires separate authorization: set ${PEAK_APPROVAL_ENV}=1 with explicit approval`);
    }
    if (args.confirmCostCap === null || args.confirmCostCap !== args.costCeilingUsd) {
      reasons.push('peak-20k requires --confirm-cost-cap matching --cost-ceiling-usd (paid cost approval)');
    }
  }
  if (reasons.length > 0) return { allowed: false, reasons: Object.freeze(reasons) };
  return {
    allowed: true,
    plan: Object.freeze({
      profile: args.profile,
      activeTurns: profile.activeTurns,
      target: args.target,
      identity: args.identity,
      durationS: args.durationS,
      costCeilingUsd: args.costCeilingUsd,
      method: args.method,
      path: args.path,
      maxConnections: args.maxConnections,
      abortShedRate: args.abortShedRate,
    }),
  };
}

export interface LoadAgentReport {
  readonly tool: string;
  readonly status: 'planned' | 'refused' | 'completed' | 'aborted' | 'usage_error';
  readonly profile?: string | undefined;
  readonly plan?: LoadPlan | undefined;
  readonly reasons?: readonly string[] | undefined;
  readonly metrics?: LoadMetrics | undefined;
}

export interface LoadMetrics {
  readonly requests: number;
  readonly ok: number;
  readonly shed: number;
  readonly errors: number;
  readonly resets: number;
  readonly shedRate: number;
  readonly elapsedMs: number;
  readonly retryAfterHonored: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function singleRequest(plan: LoadPlan, timeoutMs: number): Promise<{ kind: 'ok' | 'shed' | 'error' | 'reset'; retryAfterMs: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { kind: 'ok' | 'shed' | 'error' | 'reset'; retryAfterMs: number }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const url = new URL(plan.path, plan.target);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const timer = setTimeout(() => done({ kind: 'error', retryAfterMs: 0 }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    let request: ReturnType<typeof httpsRequest>;
    try {
      request = transport(
        {
          hostname: url.hostname,
          port: url.port !== '' ? Number(url.port) : undefined,
          path: `${url.pathname}${url.search}`,
          method: plan.method,
          timeout: timeoutMs,
          headers: {
            'x-load-test-identity': plan.identity,
            'x-load-test-profile': plan.profile,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          response.on('end', () => {
            clearTimeout(timer);
            if (status >= 200 && status < 300) done({ kind: 'ok', retryAfterMs: 0 });
            else if (status === 429 || status === 503) {
              const retryAfter = Number(response.headers['retry-after']);
              done({ kind: 'shed', retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 });
            } else done({ kind: 'error', retryAfterMs: 0 });
          });
          response.on('error', () => {
            clearTimeout(timer);
            done({ kind: 'reset', retryAfterMs: 0 });
          });
        },
      );
    } catch {
      clearTimeout(timer);
      done({ kind: 'error', retryAfterMs: 0 });
      return;
    }
    request.on('timeout', () => {
      request.destroy(new Error('request timeout'));
      clearTimeout(timer);
      done({ kind: 'error', retryAfterMs: 0 });
    });
    request.on('error', (error: unknown) => {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      done({ kind: /ECONNRESET|EPIPE|socket hang up/i.test(message) ? 'reset' : 'error', retryAfterMs: 0 });
    });
    request.end();
  });
}

/** Bounded, abortable executor: fixed duration, capped concurrency, live shed abort. */
export async function executeLoad(
  plan: LoadPlan,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<LoadMetrics> {
  const startedAt = Date.now();
  const deadline = startedAt + plan.durationS * 1_000;
  let requests = 0;
  let ok = 0;
  let shed = 0;
  let errors = 0;
  let resets = 0;
  let retryAfterHonored = 0;
  const workers: Array<Promise<void>> = [];
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (let worker = 0; worker < Math.min(plan.maxConnections, 50); worker += 1) {
      workers.push((async () => {
        while (!aborted && Date.now() < deadline) {
          if (options.signal?.aborted) break;
          const total = requests + 1;
          if (total > 1 && shed / total > plan.abortShedRate && total > 20) break;
          requests += 1;
          const remaining = Math.max(1_000, deadline - Date.now());
          const result = await singleRequest(plan, Math.min(10_000, remaining));
          if (result.kind === 'ok') ok += 1;
          else if (result.kind === 'shed') {
            shed += 1;
            if (result.retryAfterMs > 0) {
              retryAfterHonored += 1;
              await sleep(Math.min(result.retryAfterMs, 5_000));
            }
          } else if (result.kind === 'reset') resets += 1;
          else errors += 1;
        }
      })());
    }
    await Promise.all(workers);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  const elapsedMs = Date.now() - startedAt;
  return {
    requests,
    ok,
    shed,
    errors,
    resets,
    shedRate: requests === 0 ? 0 : shed / requests,
    elapsedMs,
    retryAfterHonored,
  };
}

function writeReport(path: string, report: LoadAgentReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && (entry.endsWith('load-agent.ts') || entry.endsWith('load-agent.js'));
}

if (isMainModule()) {
  (async () => {
    let parsed: ParsedLoadAgentArgs | null = null;
    try {
      parsed = parseLoadAgentArgs(process.argv.slice(2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`load:agent usage: ${message}`);
      process.exit(2);
    }
    const args = parsed as ParsedLoadAgentArgs;
    const decision = authorizeLoad(args, process.env);
    if (!decision.allowed) {
      const report: LoadAgentReport = {
        tool: LOAD_AGENT_VERSION,
        status: 'refused',
        profile: args.profile,
        reasons: decision.reasons,
      };
      writeReport(args.report, report);
      console.error(`load:agent refused:\n${decision.reasons.map((reason) => `  - ${reason}`).join('\n')}`);
      process.exit(2);
    }
    if (!args.execute) {
      const report: LoadAgentReport = { tool: LOAD_AGENT_VERSION, status: 'planned', profile: args.profile, plan: decision.plan };
      writeReport(args.report, report);
      console.log(`load:agent dry-run plan written to ${args.report} (no traffic without --execute)`);
      process.exit(0);
    }
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.on('SIGINT', onSigint);
    try {
      const metrics = await executeLoad(decision.plan, { signal: controller.signal });
      const aborted = metrics.requests > 20 && metrics.shedRate > decision.plan.abortShedRate;
      const report: LoadAgentReport = {
        tool: LOAD_AGENT_VERSION,
        status: aborted ? 'aborted' : 'completed',
        profile: args.profile,
        plan: decision.plan,
        metrics,
      };
      writeReport(args.report, report);
      console.log(`load:agent ${report.status}: ${JSON.stringify(metrics)}`);
      process.exit(aborted ? 3 : 0);
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  })().catch((error: unknown) => {
    console.error('load:agent failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
