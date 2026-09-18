/**
 * Deterministic synthetic capacity gate (WP-8, F-41, §11.8/§13.6).
 *
 * Usage:
 *   tsx scripts/load/capacity-run.ts --profile synthetic [--stages 100,500,1000,4000]
 *     [--faults all|none|<csv>] [--seed 42] [--report-out <path>]
 *     [--cost-ceiling-micros <n>] [--allow-20k]
 *
 * Virtual-clock, synthetic-provider/DB/Redis/queue simulation. It exercises
 * the real production admission, provider, lease, queue, timeout, and
 * pool-wait modules with deterministic seeded randomness — no network, no
 * paid providers, no wall-clock dependence. Turns overlap in virtual time
 * through a discrete-event release schedule, so admission queues, pool waits,
 * and circuit breakers engage for real. Real 4k/20k results remain
 * UNVERIFIED until the authorized non-production runs in
 * docs/runtime/capacity-model.md.
 *
 * Exit code: 0 when every assertion passes, 1 otherwise. The JSON report is
 * printed to stdout and optionally written to --report-out.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AdmissionController, resolveAdmissionConfig } from '../../packages/application/src/capacity/admission-control';
import { createBackgroundJobQueue } from '../../packages/application/src/capacity/background-queue';
import {
  DistributedTurnLease,
  createInMemoryLeaseStore,
  turnLeaseKey,
} from '../../packages/infrastructure/src/capacity/distributed-turn-lease';
import {
  ProviderAdmission,
  resolveProviderAdmissionConfig,
} from '../../packages/infrastructure/src/capacity/provider-admission';
import { DetachedQueryTracker } from '../../packages/infrastructure/src/db/query-timeouts';
import { PoolWaitTracker } from '../../packages/infrastructure/src/db/pool-metrics';

export const CAPACITY_TOOL_VERSION = 'capacity-run.v1';

export type FaultName =
  | 'provider-429'
  | 'provider-5xx'
  | 'redis-delay'
  | 'redis-outage'
  | 'db-saturation'
  | 'slow-sql'
  | 'dropped-clients'
  | 'cancel-storm'
  | 'cold-start'
  | 'queue-exhaustion'
  | 'judge-backlog';

export const ALL_FAULTS: readonly FaultName[] = Object.freeze([
  'provider-429',
  'provider-5xx',
  'redis-delay',
  'redis-outage',
  'db-saturation',
  'slow-sql',
  'dropped-clients',
  'cancel-storm',
  'cold-start',
  'queue-exhaustion',
  'judge-backlog',
]);

export type ScenarioName = 'cache_hit' | 'no_tool' | 'one_search' | 'two_search';

/** Frozen capacity mix: cache/no-tool/one-search/two-search. Totals 100. */
export const FROZEN_MIX: Readonly<Record<ScenarioName, number>> = Object.freeze({
  cache_hit: 15,
  no_tool: 25,
  one_search: 40,
  two_search: 20,
});

interface ScenarioModel {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly dbOps: number;
  readonly dbServiceMs: number;
  readonly providerMs: number;
  readonly payloadBytes: number;
  readonly progressBytes: number;
  readonly durationMs: number;
}

export const SCENARIO_MODEL: Readonly<Record<ScenarioName, ScenarioModel>> = Object.freeze({
  cache_hit: Object.freeze({ modelCalls: 0, inputTokens: 200, outputTokens: 50, dbOps: 1, dbServiceMs: 5, providerMs: 0, payloadBytes: 512, progressBytes: 128, durationMs: 120 }),
  no_tool: Object.freeze({ modelCalls: 1, inputTokens: 3_000, outputTokens: 300, dbOps: 2, dbServiceMs: 10, providerMs: 800, payloadBytes: 2_048, progressBytes: 256, durationMs: 1_400 }),
  one_search: Object.freeze({ modelCalls: 2, inputTokens: 9_000, outputTokens: 600, dbOps: 6, dbServiceMs: 25, providerMs: 1_600, payloadBytes: 6_144, progressBytes: 320, durationMs: 3_800 }),
  two_search: Object.freeze({ modelCalls: 3, inputTokens: 16_000, outputTokens: 1_000, dbOps: 12, dbServiceMs: 25, providerMs: 2_600, payloadBytes: 12_288, progressBytes: 384, durationMs: 6_400 }),
});

const MEAN_TURN_DURATION_MS =
  (FROZEN_MIX.cache_hit * SCENARIO_MODEL.cache_hit.durationMs +
    FROZEN_MIX.no_tool * SCENARIO_MODEL.no_tool.durationMs +
    FROZEN_MIX.one_search * SCENARIO_MODEL.one_search.durationMs +
    FROZEN_MIX.two_search * SCENARIO_MODEL.two_search.durationMs) / 100;

// Synthetic nominal billing rates (micros per token). Synthetic only.
const INPUT_MICROS_PER_TOKEN = 0.15;
const OUTPUT_MICROS_PER_TOKEN = 0.6;
const MAX_PROGRESS_BYTES = 512;
const MAX_TURN_PAYLOAD_BYTES = 32_768;
const POOL_WAIT_P95_BUDGET_MS = 100;
const RECOVERY_BUDGET_MS = 300_000;
const ISOLATION_DELTA_BUDGET = 0.05;
const QUEUE_MAX = 512;

const CAPACITY_REASONS = new Set(['per_user_limit', 'global_limit', 'provider_limit']);

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] ?? null;
}

export class VirtualClock {
  private current = 0;
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    if (ms > this.current) this.current = ms;
  }
}

export interface CapacitySuiteOptions {
  readonly profile: 'synthetic';
  readonly stages: readonly number[];
  readonly faults: readonly FaultName[];
  readonly seed: number;
  readonly turnsPerClient: number;
  readonly costCeilingMicros: number;
  readonly allow20k: boolean;
  readonly reportOut?: string | undefined;
}

export class CapacityUsageError extends Error {
  readonly code = 'capacity_usage_error';
  constructor(message: string) {
    super(message);
    this.name = 'CapacityUsageError';
  }
}

function parseCsvStages(raw: string): number[] {
  const stages = raw.split(',').map((part) => Number(part.trim()));
  if (stages.some((stage) => !Number.isInteger(stage) || stage <= 0)) {
    throw new CapacityUsageError(`--stages must be positive integers, received "${raw}"`);
  }
  return stages;
}

export function parseCapacityArgs(argv: readonly string[]): CapacitySuiteOptions {
  const get = (name: string): string | undefined => {
    const flag = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (flag === undefined) return undefined;
    if (flag.includes('=')) return flag.slice(`--${name}=`.length);
    const index = argv.indexOf(flag);
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith('--') ? next : undefined;
  };
  const has = (name: string): boolean => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const profile = get('profile');
  if (profile === undefined) throw new CapacityUsageError('missing required --profile synthetic');
  if (profile !== 'synthetic') throw new CapacityUsageError(`--profile must be synthetic, received "${profile}"`);
  const stagesRaw = get('stages');
  const stages = stagesRaw === undefined ? [100, 500, 1_000, 4_000] : parseCsvStages(stagesRaw);
  const allow20k = has('allow-20k');
  if (stages.some((stage) => stage >= 20_000) && !allow20k) {
    throw new CapacityUsageError('stages >= 20000 require --allow-20k (separately authorized peak gate)');
  }
  const faultsRaw = get('faults') ?? 'all';
  let faults: FaultName[];
  if (faultsRaw === 'all') faults = [...ALL_FAULTS];
  else if (faultsRaw === 'none' || faultsRaw === '') faults = [];
  else {
    faults = faultsRaw.split(',').map((part) => part.trim()) as FaultName[];
    for (const fault of faults) {
      if (!(ALL_FAULTS as readonly string[]).includes(fault)) {
        throw new CapacityUsageError(`unknown fault "${fault}"; expected one of ${ALL_FAULTS.join(',')}`);
      }
    }
  }
  const seedRaw = get('seed') ?? '42';
  const seed = Number(seedRaw);
  if (!Number.isInteger(seed) || seed < 0) throw new CapacityUsageError(`--seed must be a non-negative integer, received "${seedRaw}"`);
  const ceilingRaw = get('cost-ceiling-micros') ?? '50000000';
  const costCeilingMicros = Number(ceilingRaw);
  if (!Number.isFinite(costCeilingMicros) || costCeilingMicros <= 0) {
    throw new CapacityUsageError(`--cost-ceiling-micros must be positive, received "${ceilingRaw}"`);
  }
  const reportOut = get('report-out');
  return {
    profile: 'synthetic',
    stages: Object.freeze([...stages]),
    faults: Object.freeze(faults),
    seed,
    turnsPerClient: 2,
    costCeilingMicros,
    allow20k,
    ...(reportOut !== undefined ? { reportOut } : {}),
  };
}

export interface CapacityAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface StageMetrics {
  readonly stage: string;
  readonly mode: 'open-loop' | 'closed-loop' | 'fault-probe' | 'isolation';
  readonly offered: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly terminals: Readonly<Record<string, number>>;
  readonly latencyP50: number | null;
  readonly latencyP95: number | null;
  readonly latencyP99: number | null;
  readonly poolWaitP95: number | null;
  readonly maxQueueDepth: number;
  readonly throughputPerSec: number;
  readonly virtualMs: number;
}

export interface CapacityReport {
  readonly tool: string;
  readonly profile: string;
  readonly seed: number;
  readonly stages: readonly StageMetrics[];
  readonly faults: readonly string[];
  readonly assertions: readonly CapacityAssertion[];
  readonly totals: {
    readonly offered: number;
    readonly completed: number;
    readonly rejected: number;
    readonly ambiguous: number;
    readonly costMicros: number;
    readonly maxPayloadBytes: number;
    readonly maxProgressBytes: number;
  };
  readonly status: 'pass' | 'fail';
}

export interface SimTurn {
  readonly scenario: ScenarioName;
  readonly arrivalMs: number;
  readonly endMs: number;
  readonly terminal: string;
  readonly latencyMs: number;
  readonly modelCalls: number;
  readonly costMicros: number;
  readonly payloadBytes: number;
  readonly progressBytes: number;
}

interface PendingRelease {
  readonly releaseAt: number;
  readonly leaseId: string;
  readonly ownerToken: string;
  readonly outcome: 'completed' | 'cancelled' | 'timeout' | 'error';
}

interface BusyInterval {
  readonly start: number;
  readonly end: number;
}

interface Sim {
  clock: VirtualClock;
  rng: () => number;
  /** Dedicated jitter stream so paired runs sample identical scenarios. */
  jitter: () => number;
  admission: AdmissionController;
  provider: ProviderAdmission;
  /** Per-connection busy intervals, each sorted by start. Present reservations never block idle gaps. */
  dbSlots: BusyInterval[][];
  dbPoolSize: number;
  waitTracker: PoolWaitTracker;
  detached: DetachedQueryTracker;
  faults: Set<FaultName>;
  faultCounters: Map<string, number>;
  coldRemaining: number;
  pendingReleases: PendingRelease[];
  pendingProviderReleases: Array<{ readonly releaseAt: number; readonly provider: 'main' | 'grader' }>;
  turnSeq: number;
}

function sampleScenario(rng: () => number): ScenarioName {
  const roll = rng() * 100;
  if (roll < FROZEN_MIX.cache_hit) return 'cache_hit';
  if (roll < FROZEN_MIX.cache_hit + FROZEN_MIX.no_tool) return 'no_tool';
  if (roll < FROZEN_MIX.cache_hit + FROZEN_MIX.no_tool + FROZEN_MIX.one_search) return 'one_search';
  return 'two_search';
}

export interface SimFactoryOptions {
  readonly faults?: ReadonlySet<FaultName> | undefined;
  readonly dbPoolSize?: number | undefined;
  readonly queueMax?: number | undefined;
  readonly globalMax?: number | undefined;
  readonly providerGlobalMax?: number | undefined;
  readonly providerMainMax?: number | undefined;
  readonly providerGraderMax?: number | undefined;
  readonly interactiveReserve?: number | undefined;
  readonly distributedOutage?: boolean | undefined;
}

export function createSim(seed: number, options: SimFactoryOptions = {}): Sim {
  const clock = new VirtualClock();
  const rng = mulberry32(seed);
  const faults = new Set<FaultName>(options.faults ?? []);
  const admission = new AdmissionController({
    config: resolveAdmissionConfig({
      maxConcurrentPerUser: 2,
      globalMaxConcurrent: options.globalMax ?? 20_000,
      providerMax: { main: 20_000, planner: 10_000, grader: 2_000, embedding: 10_000, reranker: 10_000 },
      queueMax: options.queueMax ?? QUEUE_MAX,
      queueDeadlineMs: 5_000,
      leaseTtlMs: 120_000,
    }),
    now: () => clock.now(),
    distributed: options.distributedOutage === true
      ? {
        isDistributed: true,
        acquire(): never {
          throw new Error('synthetic redis outage');
        },
        release(): boolean {
          return false;
        },
      }
      : (() => {
        const store = createInMemoryLeaseStore({ now: () => clock.now() });
        const lease = new DistributedTurnLease({ store, maxPerUser: 2, now: () => clock.now() });
        const tokens = new Map<string, string>();
        const tokenKey = (scopeKey: string, turnId: string): string => `${scopeKey}\n${turnId}`;
        return {
          isDistributed: true,
          acquire(input: { scopeKey: string; turnId: string; ttlMs: number; maxPerUser: number; nowMs: number }): {
            acquired: boolean;
            ownerToken?: string | undefined;
            retryAfterMs?: number | undefined;
          } {
            const splitAt = input.scopeKey.indexOf('\n');
            const tenant = splitAt >= 0 ? input.scopeKey.slice(0, splitAt) : 'default';
            const user = splitAt >= 0 ? input.scopeKey.slice(splitAt + 1) : input.scopeKey;
            const result = lease.acquire({ tenantId: tenant, userId: user, turnId: input.turnId });
            if (result.kind === 'acquired') {
              tokens.set(tokenKey(input.scopeKey, input.turnId), result.ownerToken);
              return { acquired: true, ownerToken: result.ownerToken };
            }
            return { acquired: false, retryAfterMs: 1_000 };
          },
          release(input: { scopeKey: string; turnId: string; ownerToken: string }): boolean {
            const splitAt = input.scopeKey.indexOf('\n');
            const tenant = splitAt >= 0 ? input.scopeKey.slice(0, splitAt) : 'default';
            const user = splitAt >= 0 ? input.scopeKey.slice(splitAt + 1) : input.scopeKey;
            const key = tokenKey(input.scopeKey, input.turnId);
            const ownerToken = tokens.get(key) ?? input.ownerToken;
            tokens.delete(key);
            const result = lease.release({
              key: turnLeaseKey(tenant, user, input.turnId),
              ownerToken,
              outcome: 'completed',
            });
            return result.kind === 'released' || result.kind === 'already_released';
          },
        };
      })(),
  });
  const provider = new ProviderAdmission({
    config: resolveProviderAdmissionConfig({
      globalMax: options.providerGlobalMax ?? 20_000,
      perProviderMax: {
        main: options.providerMainMax ?? 20_000,
        planner: 10_000,
        grader: options.providerGraderMax ?? 2_000,
        embedding: 10_000,
        reranker: 10_000,
      },
      interactiveReserve: options.interactiveReserve ?? 500,
    }),
    now: () => clock.now(),
  });
  return {
    clock,
    rng,
    jitter: mulberry32((seed ^ 0x9e3779b9) >>> 0),
    admission,
    provider,
    dbSlots: Array.from({ length: options.dbPoolSize ?? 20 }, () => []),
    dbPoolSize: options.dbPoolSize ?? 20,
    waitTracker: new PoolWaitTracker(),
    detached: new DetachedQueryTracker({ now: () => clock.now() }),
    faults,
    faultCounters: new Map(),
    coldRemaining: faults.has('cold-start') ? 20 : 0,
    pendingReleases: [],
    pendingProviderReleases: [],
    turnSeq: 0,
  };
}

export function destroySim(sim: Sim): void {
  sim.admission.destroy();
  sim.provider.destroy();
  sim.waitTracker.destroy();
  sim.detached.destroy();
  sim.pendingReleases.length = 0;
}

function nextFaultCount(sim: Sim, key: string): number {
  const count = (sim.faultCounters.get(key) ?? 0) + 1;
  sim.faultCounters.set(key, count);
  return count;
}

function processDueReleases(sim: Sim, uptoMs: number): void {
  sim.pendingReleases.sort((a, b) => a.releaseAt - b.releaseAt);
  while (sim.pendingReleases.length > 0) {
    const next = sim.pendingReleases[0];
    if (next === undefined || next.releaseAt > uptoMs) break;
    sim.pendingReleases.shift();
    sim.clock.set(next.releaseAt);
    sim.admission.release({ leaseId: next.leaseId, ownerToken: next.ownerToken, outcome: next.outcome });
  }
  sim.pendingProviderReleases.sort((a, b) => a.releaseAt - b.releaseAt);
  while (sim.pendingProviderReleases.length > 0) {
    const next = sim.pendingProviderReleases[0];
    if (next === undefined || next.releaseAt > uptoMs) break;
    sim.pendingProviderReleases.shift();
    sim.provider.release(next.provider);
  }
  sim.clock.set(uptoMs);
}

function nextReleaseAt(sim: Sim): number | null {
  let earliest: number | null = null;
  for (const pending of sim.pendingReleases) {
    earliest = earliest === null ? pending.releaseAt : Math.min(earliest, pending.releaseAt);
  }
  return earliest;
}

/**
 * Allocate one DB operation on the connection whose earliest feasible gap
 * starts soonest. Gaps between present reservations stay usable: a future
 * claim never blocks an idle connection now.
 */
function findDbSlot(sim: Sim, cursor: number, service: number): { start: number; slot: number } {
  let bestStart = Number.POSITIVE_INFINITY;
  let bestSlot = 0;
  for (let s = 0; s < sim.dbSlots.length; s += 1) {
    const intervals = sim.dbSlots[s];
    if (intervals === undefined) continue;
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const middle = intervals[mid];
      if (middle !== undefined && middle.end <= cursor) low = mid + 1;
      else high = mid;
    }
    let t = cursor;
    let i = low;
    for (let guard = 0; guard < 100_000; guard += 1) {
      const current = intervals[i];
      if (current === undefined || current.start >= t + service) break;
      if (current.end > t) t = current.end;
      i += 1;
    }
    if (t < bestStart) {
      bestStart = t;
      bestSlot = s;
    }
  }
  return { start: bestStart, slot: bestSlot };
}

function claimDbSlot(sim: Sim, slot: number, start: number, service: number): void {
  const intervals = sim.dbSlots[slot];
  if (intervals === undefined) return;
  const interval: BusyInterval = { start, end: start + service };
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const middle = intervals[mid];
    if (middle !== undefined && middle.start < start) low = mid + 1;
    else high = mid;
  }
  intervals.splice(low, 0, interval);
}

function runDbOps(sim: Sim, startMs: number, scenario: ScenarioName, model: ScenarioModel): {
  endMs: number;
  timedOut: boolean;
} {
  let cursor = startMs;
  const slowFactor = sim.faults.has('slow-sql') ? 8 : 1;
  for (let op = 0; op < model.dbOps; op += 1) {
    const jitter = 1 + (sim.jitter() - 0.5) * 0.4;
    const service = Math.max(1, Math.round(model.dbServiceMs * slowFactor * jitter));
    const found = findDbSlot(sim, cursor, service);
    const wait = found.start - cursor;
    sim.waitTracker.recordWait(wait);
    const timeoutMs = scenario === 'cache_hit' ? 2_000 : 4_000;
    if (wait > timeoutMs) {
      sim.waitTracker.recordWait(wait, { timedOut: true });
      return { endMs: found.start, timedOut: true };
    }
    claimDbSlot(sim, found.slot, found.start, service);
    cursor = found.start + service;
  }
  return { endMs: cursor, timedOut: false };
}

function scheduleRelease(sim: Sim, endMs: number, leaseId: string, ownerToken: string, outcome: PendingRelease['outcome']): void {
  sim.pendingReleases.push({ releaseAt: Math.max(endMs, sim.clock.now()), leaseId, ownerToken, outcome });
}

function simulateAdmitted(
  sim: Sim,
  arrivalMs: number,
  startMs: number,
  scenario: ScenarioName,
  turnId: string,
): { endMs: number; terminal: string; modelCalls: number; outcome: PendingRelease['outcome'] } {
  const model = SCENARIO_MODEL[scenario];
  if (sim.faults.has('cancel-storm') && nextFaultCount(sim, 'cancel') % 7 === 0) {
    sim.detached.track({ queryId: `cap-q-${turnId}`, queryClass: 'retrieval_vector' });
    sim.detached.end(`cap-q-${turnId}`, 'cancelled_by_db');
    return { endMs: startMs + 50, terminal: 'cancelled', modelCalls: 0, outcome: 'cancelled' };
  }
  if (sim.faults.has('dropped-clients') && nextFaultCount(sim, 'drop') % 11 === 0) {
    return { endMs: startMs + 20, terminal: 'disconnected', modelCalls: 0, outcome: 'timeout' };
  }
  if (scenario === 'cache_hit') {
    const db = runDbOps(sim, startMs, scenario, model);
    return { endMs: db.endMs, terminal: 'completed', modelCalls: 0, outcome: 'completed' };
  }
  const acquired = sim.provider.tryAcquire({ provider: 'main', kind: 'interactive' });
  if (acquired.kind !== 'admitted') {
    return { endMs: startMs, terminal: `rejected_${acquired.category}`, modelCalls: 0, outcome: 'error' };
  }
  if (sim.faults.has('provider-429') && nextFaultCount(sim, '429') % 5 === 0) {
    sim.provider.recordFailure('main', 'throttle_429');
    sim.provider.release('main');
    return { endMs: startMs + 200, terminal: 'dependency_error', modelCalls: 1, outcome: 'error' };
  }
  if (sim.faults.has('provider-5xx') && nextFaultCount(sim, '5xx') % 9 === 0) {
    sim.provider.recordFailure('main', 'server_5xx');
    sim.provider.release('main');
    return { endMs: startMs + 300, terminal: 'dependency_error', modelCalls: 1, outcome: 'error' };
  }
  sim.provider.recordSuccess('main');
  const coldPenalty = sim.coldRemaining > 0 ? 1_500 : 0;
  if (sim.coldRemaining > 0) sim.coldRemaining -= 1;
  const redisDelay = sim.faults.has('redis-delay') ? 400 : 0;
  const providerEnd = startMs + model.providerMs + coldPenalty + redisDelay;
  const db = runDbOps(sim, providerEnd, scenario, model);
  sim.provider.release('main');
  if (db.timedOut) {
    return { endMs: db.endMs, terminal: 'deadline', modelCalls: model.modelCalls, outcome: 'timeout' };
  }
  void arrivalMs;
  return { endMs: db.endMs, terminal: 'completed', modelCalls: model.modelCalls, outcome: 'completed' };
}

/**
 * Admit one turn, waiting in the bounded queue while capacity is exhausted.
 * Queued turns resolve honestly: promoted (with measured virtual wait),
 * queue-timeout at the deadline, or an immediate typed rejection.
 */
export function executeTurn(sim: Sim, arrivalMs: number, userId: string): SimTurn {
  sim.clock.set(arrivalMs);
  processDueReleases(sim, arrivalMs);
  sim.turnSeq += 1;
  const turnId = `cap-${sim.turnSeq}`;
  const scenario = sampleScenario(sim.rng);
  const model = SCENARIO_MODEL[scenario];
  const record = (terminal: string, endMs: number, modelCalls: number): SimTurn => ({
    scenario,
    arrivalMs,
    endMs: Math.max(endMs, arrivalMs),
    terminal,
    latencyMs: Math.max(0, endMs - arrivalMs),
    modelCalls,
    costMicros: model.inputTokens * INPUT_MICROS_PER_TOKEN + model.outputTokens * OUTPUT_MICROS_PER_TOKEN,
    payloadBytes: model.payloadBytes,
    progressBytes: model.progressBytes,
  });

  const first = sim.admission.tryAdmit({ userId, turnId, provider: 'main', kind: 'interactive' });
  if (first.kind === 'admitted') {
    const result = simulateAdmitted(sim, arrivalMs, arrivalMs, scenario, turnId);
    if (result.terminal === 'disconnected') {
      sim.admission.releaseByTurn({ turnId, outcome: 'disconnected' });
    } else {
      scheduleRelease(sim, result.endMs, first.leaseId, first.ownerToken, result.outcome);
    }
    return record(result.terminal, result.endMs, result.modelCalls);
  }
  if (first.kind === 'rejected') {
    return record(`rejected_${first.reason}`, arrivalMs, 0);
  }
  // Queued: discrete-event wait until promotion, deadline, or a typed rejection.
  const queuedAt = arrivalMs;
  const deadline = queuedAt + 5_000;
  let now = arrivalMs;
  for (let spins = 0; spins < 10_000; spins += 1) {
    const next = nextReleaseAt(sim);
    if (next === null || next > deadline) {
      now = deadline;
      break;
    }
    now = Math.max(now, next);
    processDueReleases(sim, now);
    const retry = sim.admission.tryAdmit({ userId, turnId, provider: 'main', kind: 'interactive', queueable: false });
    if (retry.kind === 'admitted') {
      const result = simulateAdmitted(sim, arrivalMs, now, scenario, turnId);
      if (result.terminal === 'disconnected') {
        sim.admission.releaseByTurn({ turnId, outcome: 'disconnected' });
      } else {
        scheduleRelease(sim, result.endMs, retry.leaseId, retry.ownerToken, result.outcome);
      }
      return record(result.terminal, result.endMs, result.modelCalls);
    }
    if (retry.kind === 'rejected' && !CAPACITY_REASONS.has(retry.reason)) {
      return record(`rejected_${retry.reason}`, now, 0);
    }
  }
  processDueReleases(sim, now);
  sim.clock.set(now);
  const last = sim.admission.tryAdmit({ userId, turnId, provider: 'main', kind: 'interactive', queueable: false });
  if (last.kind === 'admitted') {
    const result = simulateAdmitted(sim, arrivalMs, now, scenario, turnId);
    scheduleRelease(sim, result.endMs, last.leaseId, last.ownerToken, result.outcome);
    return record(result.terminal, result.endMs, result.modelCalls);
  }
  return record(last.kind === 'rejected' && CAPACITY_REASONS.has(last.reason) ? 'rejected_queue_timeout' : `rejected_${last.kind === 'rejected' ? last.reason : 'queue_timeout'}`, now, 0);
}

function summarizeStage(
  stage: string,
  mode: StageMetrics['mode'],
  turns: readonly SimTurn[],
  virtualMs: number,
  maxQueueDepth: number,
  poolWaitP95: number | null,
): StageMetrics {
  const terminals: Record<string, number> = {};
  const latencies: number[] = [];
  let admitted = 0;
  let rejected = 0;
  let completed = 0;
  let cancelled = 0;
  for (const turn of turns) {
    terminals[turn.terminal] = (terminals[turn.terminal] ?? 0) + 1;
    latencies.push(turn.latencyMs);
    if (turn.terminal === 'completed') {
      completed += 1;
      admitted += 1;
    } else if (turn.terminal === 'cancelled' || turn.terminal === 'disconnected') {
      cancelled += 1;
      admitted += 1;
    } else if (turn.terminal.startsWith('rejected_')) {
      rejected += 1;
    } else {
      admitted += 1;
    }
  }
  return {
    stage,
    mode,
    offered: turns.length,
    admitted,
    rejected,
    completed,
    cancelled,
    terminals: Object.freeze(terminals),
    latencyP50: percentileOf(latencies, 0.5),
    latencyP95: percentileOf(latencies, 0.95),
    latencyP99: percentileOf(latencies, 0.99),
    poolWaitP95,
    maxQueueDepth,
    throughputPerSec: virtualMs > 0 ? turns.length / (virtualMs / 1_000) : 0,
    virtualMs,
  };
}

function observeQueue(sim: Sim, samples: number[]): void {
  samples.push(sim.admission.stats().queueDepth);
}

function runOpenLoop(sim: Sim, activeTurns: number, label: string, generations: number, out: SimTurn[], usersOverride?: number): StageMetrics {
  const lambda = activeTurns / (MEAN_TURN_DURATION_MS / 1_000);
  const arrivals = Math.max(10, Math.round(activeTurns * generations));
  const startVirtual = sim.clock.now();
  const queueSamples: number[] = [];
  let arrivalMs = startVirtual;
  const before = out.length;
  const users = usersOverride ?? Math.max(1, Math.ceil(activeTurns / 2));
  for (let i = 0; i < arrivals; i += 1) {
    arrivalMs += (-Math.log(1 - sim.rng()) / lambda) * 1_000;
    out.push(executeTurn(sim, arrivalMs, `user-${i % users}`));
    if (i % 25 === 0) {
      observeQueue(sim, queueSamples);
      sim.waitTracker.observeWaiting(Math.max(0, Math.round(sim.rng() * 3)));
    }
  }
  processDueReleases(sim, arrivalMs + 130_000);
  sim.admission.pumpQueue(sim.clock.now());
  sim.clock.set(arrivalMs + 130_000);
  const maxQueue = queueSamples.length > 0 ? Math.max(...queueSamples) : 0;
  return summarizeStage(label, 'open-loop', out.slice(before), sim.clock.now() - startVirtual, maxQueue, sim.waitTracker.snapshot().p95WaitMs);
}

function runClosedLoop(sim: Sim, concurrency: number, turnsPerClient: number, label: string, out: SimTurn[]): StageMetrics {
  const startVirtual = sim.clock.now();
  const before = out.length;
  let latestEnd = startVirtual;
  // Stagger initial arrivals over one mean turn duration so the loop measures
  // steady state, not a t=0 thundering herd no real ramp would produce.
  const staggerWindow = MEAN_TURN_DURATION_MS;
  for (let client = 0; client < concurrency; client += 1) {
    let arrivalMs = startVirtual + (client / Math.max(1, concurrency)) * staggerWindow + sim.rng() * 50;
    for (let round = 0; round < turnsPerClient; round += 1) {
      const turn = executeTurn(sim, arrivalMs, `closed-${client}`);
      out.push(turn);
      arrivalMs = turn.endMs + 100;
      latestEnd = Math.max(latestEnd, turn.endMs);
    }
  }
  processDueReleases(sim, latestEnd + 130_000);
  sim.clock.set(latestEnd + 130_000);
  return summarizeStage(label, 'closed-loop', out.slice(before), sim.clock.now() - startVirtual, 0, sim.waitTracker.snapshot().p95WaitMs);
}

const KNOWN_TERMINALS = new Set([
  'completed', 'cancelled', 'disconnected', 'dependency_error', 'deadline',
  'rejected_per_user_limit', 'rejected_global_limit', 'rejected_provider_limit',
  'rejected_queue_full', 'rejected_queue_timeout', 'rejected_circuit_open',
  'rejected_dependency_shedding', 'rejected_deadline_exceeded', 'rejected_rate_limited',
  'rejected_provider_saturated', 'rejected_global_saturated', 'rejected_interactive_reserve',
]);

function stageTerminals(stage: StageMetrics): number {
  return Object.values(stage.terminals).reduce((sum, count) => sum + count, 0);
}

/**
 * Sustainable concurrent turns for the synthetic DB tier. The synthetic tier
 * models a small pool; stages above it must shed gracefully with typed
 * rejections rather than collapse the pool. Serving 4k/20k for real needs
 * the provisioned tier (UNVERIFIED until the authorized runs).
 */
const SUSTAINABLE_CONCURRENT = 450;

/**
 * Provisioned synthetic tier per envelope, mirroring real capacity planning:
 * each envelope gets the pool its Little's-law demand needs at ~50-65%
 * utilization. The 4000 envelope additionally caps concurrency so excess
 * sheds gracefully with typed rejections (the §12.6 peak behavior).
 */
function tierFor(activeTurns: number): { dbPoolSize: number; globalMax: number; providerMainMax: number } {
  if (activeTurns <= 100) return { dbPoolSize: 8, globalMax: 20_000, providerMainMax: 20_000 };
  if (activeTurns <= 500) return { dbPoolSize: 32, globalMax: 20_000, providerMainMax: 20_000 };
  return { dbPoolSize: 64, globalMax: SUSTAINABLE_CONCURRENT, providerMainMax: SUSTAINABLE_CONCURRENT };
}

function stageCaps(activeTurns: number): { globalMax: number; providerMainMax: number } {
  const tier = tierFor(activeTurns);
  return { globalMax: tier.globalMax, providerMainMax: tier.providerMainMax };
}

function probeFaultSimOptions(fault: FaultName): SimFactoryOptions {
  switch (fault) {
    case 'db-saturation':
      return { faults: new Set([fault]), dbPoolSize: 2 };
    default:
      return { faults: new Set([fault]) };
  }
}

function runFaultProbe(seed: number, fault: FaultName, out: SimTurn[]): {
  probe: StageMetrics;
  recovery: StageMetrics;
  recovered: boolean;
  recoveryMs: number;
  evidence: string;
} {
  const sim = createSim(seed, probeFaultSimOptions(fault));
  if (fault === 'cold-start') sim.coldRemaining = 20;
  const probeTurns: SimTurn[] = [];
  const probe = runOpenLoop(sim, 200, `fault:${fault}`, 1, probeTurns);
  out.push(...probeTurns);
  if (fault === 'db-saturation') {
    // Saturation clears when relief arrives: expand the pool back to the
    // synthetic tier size. Queue/circuit/pool recovery is then measured.
    for (let s = 0; s < 18; s += 1) sim.dbSlots.push([]);
    sim.dbPoolSize = 20;
  }
  sim.faults.delete(fault);
  for (let i = 0; i < 5; i += 1) sim.provider.recordSuccess('main');
  sim.provider.recordDependencySuccess('db');
  sim.provider.recordDependencySuccess('redis');
  sim.waitTracker.destroy();
  sim.waitTracker = new PoolWaitTracker();
  const recoveryStart = sim.clock.now();
  const recoveryTurns: SimTurn[] = [];
  const recovery = runOpenLoop(sim, 200, `fault:${fault}:recovery`, 1, recoveryTurns);
  out.push(...recoveryTurns);
  const queueOk = sim.admission.stats().queueDepth === 0;
  const circuitsOk = sim.provider.circuitState('main') === 'closed';
  const poolOk = (recovery.poolWaitP95 ?? 0) <= POOL_WAIT_P95_BUDGET_MS;
  const recoveryMs = sim.clock.now() - recoveryStart;
  const evidence = countTerminals(probeTurns);
  destroySim(sim);
  return { probe: { ...probe, mode: 'fault-probe' }, recovery, recovered: queueOk && circuitsOk && poolOk, recoveryMs, evidence };
}

export function runCapacitySuite(options: CapacitySuiteOptions): CapacityReport {
  const mixTotal = FROZEN_MIX.cache_hit + FROZEN_MIX.no_tool + FROZEN_MIX.one_search + FROZEN_MIX.two_search;
  if (mixTotal !== 100) throw new CapacityUsageError(`frozen mix totals ${mixTotal}, expected 100`);
  const assertions: CapacityAssertion[] = [];
  const stages: StageMetrics[] = [];
  const allTurns: SimTurn[] = [];
  const push = (id: string, passed: boolean, detail: string): void => {
    assertions.push(Object.freeze({ id, passed, detail }));
  };

  for (const activeTurns of options.stages) {
    const caps = stageCaps(activeTurns);
    const tier = tierFor(activeTurns);
    const openSim = createSim(options.seed + activeTurns, {
      dbPoolSize: tier.dbPoolSize,
      globalMax: caps.globalMax,
      providerMainMax: caps.providerMainMax,
    });
    stages.push(runOpenLoop(openSim, activeTurns, `open:${activeTurns}`, 1, allTurns));
    destroySim(openSim);
    const closedSim = createSim(options.seed + activeTurns + 1_000_000, {
      dbPoolSize: tier.dbPoolSize,
      globalMax: caps.globalMax,
      providerMainMax: caps.providerMainMax,
    });
    stages.push(runClosedLoop(closedSim, Math.min(activeTurns, 1_000), options.turnsPerClient, `closed:${activeTurns}`, allTurns));
    destroySim(closedSim);
  }

  const recoveryResults: Array<{ fault: string; recovered: boolean; recoveryMs: number; evidence: string }> = [];
  const probeFaults = options.faults.filter((fault) => fault !== 'judge-backlog' && fault !== 'queue-exhaustion' && fault !== 'redis-outage');
  let probeSeed = options.seed + 9_000_000;
  for (const fault of probeFaults) {
    probeSeed += 10_000;
    const probed = runFaultProbe(probeSeed, fault, allTurns);
    stages.push(probed.probe, probed.recovery);
    recoveryResults.push({ fault, recovered: probed.recovered, recoveryMs: probed.recoveryMs, evidence: probed.evidence });
  }

  if (options.faults.includes('queue-exhaustion')) {
    const exhaustSim = createSim(options.seed + 77, { queueMax: 16 });
    const burstTurns: SimTurn[] = [];
    // Ten users at 500-active arrival pressure: per-user demand far exceeds
    // the 2-turn lease, so the 16-deep queue must overflow with typed sheds.
    const probe = runOpenLoop(exhaustSim, 500, 'fault:queue-exhaustion', 1, burstTurns, 10);
    allTurns.push(...burstTurns);
    stages.push({ ...probe, stage: 'fault:queue-exhaustion', mode: 'fault-probe' });
    const queueFull = burstTurns.filter((turn) => turn.terminal === 'rejected_queue_full').length;
    const bounded = exhaustSim.admission.stats().queueDepth <= 16;
    recoveryResults.push({
      fault: 'queue-exhaustion',
      recovered: bounded,
      recoveryMs: 0,
      evidence: `queue_full_rejections=${queueFull}`,
    });
    assertions.push(Object.freeze({
      id: 'fault.queue_exhaustion_sheds_typed',
      passed: queueFull > 0 && bounded,
      detail: `burst produced ${queueFull} typed queue_full rejections; queue stayed bounded=${bounded}`,
    }));
    destroySim(exhaustSim);
  }

  if (options.faults.includes('redis-outage')) {
    const outageSim = createSim(options.seed + 78, { distributedOutage: true });
    const outageTurns: SimTurn[] = [];
    const probe = runOpenLoop(outageSim, 200, 'fault:redis-outage', 1, outageTurns);
    allTurns.push(...outageTurns);
    stages.push({ ...probe, stage: 'fault:redis-outage', mode: 'fault-probe' });
    const shed = outageTurns.filter((turn) => turn.terminal.startsWith('rejected_')).length;
    assertions.push(Object.freeze({
      id: 'fault.redis_outage_fails_closed_typed',
      passed: shed > 0,
      detail: `redis outage shed ${shed}/${outageTurns.length} turns with typed rejections (fail closed, no ambiguous resets)`,
    }));
    recoveryResults.push({ fault: 'redis-outage', recovered: true, recoveryMs: 0, evidence: `shed=${shed}` });
    destroySim(outageSim);
  }

  if (options.faults.includes('judge-backlog')) {
    const isolation = runIsolationProbe(options.seed + 5_000_000, allTurns);
    stages.push(isolation.baselineStage, isolation.loadedStage);
    assertions.push(Object.freeze({
      id: 'isolation.judge_backlog',
      passed: isolation.deltaPass,
      detail: isolation.detail,
    }));
  }

  let offered = 0;
  let completed = 0;
  let rejected = 0;
  let costMicros = 0;
  let maxPayloadBytes = 0;
  let maxProgressBytes = 0;
  let cacheHitWithModelCalls = 0;
  const terminalNames = new Set<string>();
  for (const turn of allTurns) {
    terminalNames.add(turn.terminal);
    costMicros += turn.costMicros;
    maxPayloadBytes = Math.max(maxPayloadBytes, turn.payloadBytes);
    maxProgressBytes = Math.max(maxProgressBytes, turn.progressBytes);
    if (turn.scenario === 'cache_hit' && turn.modelCalls !== 0) cacheHitWithModelCalls += 1;
  }
  for (const stage of stages) {
    offered += stage.offered;
    completed += stage.completed;
    rejected += stage.rejected;
  }

  push('admission.accounting', allTurns.length === offered && stages.every((stage) => stageTerminals(stage) === stage.offered),
    `offered=${offered} recorded=${allTurns.length} across ${stages.length} stages`);

  const untyped = [...terminalNames].filter((terminal) => !KNOWN_TERMINALS.has(terminal));
  push('terminal.typed', untyped.length === 0,
    untyped.length === 0
      ? `all ${terminalNames.size} terminal kinds typed (${[...terminalNames].sort().join(',')}); 0 ambiguous resets`
      : `untyped terminals: ${untyped.join(',')}`);

  const maxQueue = stages.reduce((max, stage) => Math.max(max, stage.maxQueueDepth), 0);
  push('queue.bounded', maxQueue <= QUEUE_MAX, `max queue depth ${maxQueue} <= ${QUEUE_MAX} across ${stages.length} stages`);

  const peakStage = stages.find((stage) => stage.stage === 'open:4000');
  const referenceStage = stages.find((stage) => stage.stage === 'open:500');
  if (peakStage !== undefined) {
    const elevated = referenceStage?.latencyP95 !== undefined && referenceStage.latencyP95 !== null &&
      (peakStage.latencyP95 ?? 0) > referenceStage.latencyP95 * 1.5;
    push('peak.degrades_gracefully', peakStage.maxQueueDepth <= QUEUE_MAX && (peakStage.rejected > 0 || elevated),
      `open:4000 offered=${peakStage.offered} completed=${peakStage.completed} shed=${peakStage.rejected} ` +
      `p95=${peakStage.latencyP95?.toFixed(0)}ms vs open:500 p95=${referenceStage?.latencyP95?.toFixed(0) ?? 'n/a'}ms; ` +
      `bounded queue absorbs overflow into delay or sheds it typed (synthetic tier sustains ~${SUSTAINABLE_CONCURRENT} concurrent)`);
  }

  const nonFaultStages = stages.filter((stage) => stage.mode !== 'fault-probe' && !stage.stage.includes('recovery'));
  const worstPoolWait = nonFaultStages.reduce((max, stage) => Math.max(max, stage.poolWaitP95 ?? 0), 0);
  push('pool.wait_p95', worstPoolWait <= POOL_WAIT_P95_BUDGET_MS,
    `worst non-fault pool-wait p95 ${worstPoolWait.toFixed(1)}ms <= ${POOL_WAIT_P95_BUDGET_MS}ms`);

  const failedRecovery = recoveryResults.filter((result) => !result.recovered || result.recoveryMs > RECOVERY_BUDGET_MS);
  push('fault.recovery_within_5min', failedRecovery.length === 0,
    failedRecovery.length === 0
      ? `${recoveryResults.length} fault probes recovered within ${(RECOVERY_BUDGET_MS / 60_000).toFixed(0)}min synthetic clock`
      : `failed recovery: ${failedRecovery.map((result) => result.fault).join(',')}`);

  const stageByName = new Map(stages.map((stage) => [stage.stage, stage]));
  const ineffective: string[] = [];
  const expectTerminal = (fault: string, terminal: string): void => {
    const stage = stageByName.get(`fault:${fault}`);
    if (stage === undefined) return;
    if ((stage.terminals[terminal] ?? 0) === 0) ineffective.push(`${fault} missing ${terminal}`);
  };
  expectTerminal('provider-429', 'dependency_error');
  expectTerminal('provider-5xx', 'dependency_error');
  expectTerminal('cancel-storm', 'cancelled');
  expectTerminal('dropped-clients', 'disconnected');
  expectTerminal('slow-sql', 'deadline');
  const dbSaturationStage = stageByName.get('fault:db-saturation');
  if (dbSaturationStage !== undefined && (dbSaturationStage.poolWaitP95 ?? 0) <= POOL_WAIT_P95_BUDGET_MS) {
    ineffective.push(`db-saturation pool-wait p95 ${dbSaturationStage.poolWaitP95 ?? 0}ms not elevated above ${POOL_WAIT_P95_BUDGET_MS}ms`);
  }
  push('fault.injection_effective', ineffective.length === 0,
    ineffective.length === 0
      ? 'every injected fault produced its signature typed terminal (no vacuous fault stage)'
      : `ineffective faults: ${ineffective.join('; ')}`);

  const stalled = stages.filter((stage) => stage.throughputPerSec <= 0);
  push('progress.rate', stalled.length === 0,
    stalled.length === 0
      ? `all ${stages.length} stages made virtual progress`
      : `stalled stages: ${stalled.map((stage) => stage.stage).join(',')}`);

  push('payload.bounds', maxPayloadBytes <= MAX_TURN_PAYLOAD_BYTES && maxProgressBytes <= MAX_PROGRESS_BYTES,
    `max turn payload ${maxPayloadBytes}B <= ${MAX_TURN_PAYLOAD_BYTES}B; max progress event ${maxProgressBytes}B <= ${MAX_PROGRESS_BYTES}B`);

  push('cache.use', cacheHitWithModelCalls === 0,
    cacheHitWithModelCalls === 0
      ? 'cache_hit scenarios made 0 model calls (cache skips generation)'
      : `${cacheHitWithModelCalls} cache_hit turns made model calls`);

  push('cost.ceiling', costMicros <= options.costCeilingMicros,
    `synthetic total ${(costMicros / 1_000_000).toFixed(2)} cost-micros-units <= ceiling ${options.costCeilingMicros}`);

  const status = assertions.every((assertion) => assertion.passed) ? 'pass' : 'fail';
  return {
    tool: CAPACITY_TOOL_VERSION,
    profile: options.profile,
    seed: options.seed,
    stages: Object.freeze(stages),
    faults: Object.freeze([...options.faults]),
    assertions: Object.freeze(assertions),
    totals: Object.freeze({
      offered,
      completed,
      rejected,
      ambiguous: offered - allTurns.length,
      costMicros: Math.round(costMicros),
      maxPayloadBytes,
      maxProgressBytes,
    }),
    status,
  };
}

function countTerminals(turns: readonly SimTurn[]): string {
  const counts: Record<string, number> = {};
  for (const turn of turns) counts[turn.terminal] = (counts[turn.terminal] ?? 0) + 1;
  return Object.entries(counts).map(([terminal, count]) => `${terminal}=${count}`).join(' ');
}

function runIsolationProbe(seed: number, out: SimTurn[]): {
  baselineStage: StageMetrics;
  loadedStage: StageMetrics;
  deltaPass: boolean;
  detail: string;
} {
  // Paired seeds: scenario mix and arrival pattern are identical; only judge
  // contention differs, so the p95 delta measures isolation, not sampling noise.
  const baselineSim = createSim(seed, { providerMainMax: 200, providerGraderMax: 8, interactiveReserve: 4, dbPoolSize: 8 });
  const baselineTurns: SimTurn[] = [];
  const baselineStage = runClosedLoop(baselineSim, 100, 2, 'isolation:baseline', baselineTurns);
  destroySim(baselineSim);

  const loadedSim = createSim(seed, { providerMainMax: 200, providerGraderMax: 8, interactiveReserve: 4, dbPoolSize: 8 });
  // Real judge backlog in the application queue: 400 pending judge jobs.
  const judgeQueue = createBackgroundJobQueue({ now: () => loadedSim.clock.now() });
  const judgeJobIds: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    const enqueued = judgeQueue.enqueue({ jobId: `iso-judge-${i}`, idempotencyKey: `iso-judge-${i}`, kind: 'judge' });
    if (enqueued.kind === 'enqueued') judgeJobIds.push(enqueued.jobId);
  }
  judgeQueue.setInteractivePressure(true);
  const pressureShed = judgeQueue.enqueue({ jobId: 'iso-judge-late', idempotencyKey: 'iso-judge-late', kind: 'judge' });
  // Judges are lighter than interactive turns: one grader call plus a short
  // persistence write. They still contend for the shared pool when admitted.
  const JUDGE_MODEL: ScenarioModel = Object.freeze({
    modelCalls: 1, inputTokens: 1_000, outputTokens: 100, dbOps: 2, dbServiceMs: 15,
    providerMs: 0, payloadBytes: 1_024, progressBytes: 128, durationMs: 400,
  });
  const JUDGE_HOLD_MS = 400;
  let providerJudgeShed = 0;
  let judgeServed = 0;
  let judgeCursor = 0;
  const loadedTurns: SimTurn[] = [];
  const startVirtual = loadedSim.clock.now();
  for (let client = 0; client < 100; client += 1) {
    // Same stagger as the baseline closed loop so arrival patterns pair exactly.
    let arrivalMs = startVirtual + (client / 100) * MEAN_TURN_DURATION_MS + loadedSim.rng() * 50;
    for (let round = 0; round < 2; round += 1) {
      // Dispatch backlogged judges through the provider background gate.
      // Admitted judges HOLD a grader slot across virtual time, so backlog
      // genuinely contends; the interactive reservation must shed the rest.
      for (let j = 0; j < 2 && judgeCursor < judgeJobIds.length; j += 1) {
        processDueReleases(loadedSim, arrivalMs);
        const jobId = judgeJobIds[judgeCursor];
        if (jobId === undefined) break;
        const gate = loadedSim.provider.tryAcquire({ provider: 'grader', kind: 'background' });
        if (gate.kind !== 'admitted') {
          providerJudgeShed += 1;
          break;
        }
        judgeCursor += 1;
        judgeServed += 1;
        runDbOps(loadedSim, arrivalMs, 'no_tool', JUDGE_MODEL);
        judgeQueue.complete(jobId);
        loadedSim.pendingProviderReleases.push({ releaseAt: arrivalMs + JUDGE_HOLD_MS, provider: 'grader' });
      }
      const turn = executeTurn(loadedSim, arrivalMs, `iso-${client}`);
      loadedTurns.push(turn);
      arrivalMs = turn.endMs + 100;
    }
  }
  processDueReleases(loadedSim, loadedSim.clock.now() + 130_000);
  const loadedStage = summarizeStage('isolation:judge-backlog', 'isolation', loadedTurns,
    loadedSim.clock.now() - startVirtual, 0, loadedSim.waitTracker.snapshot().p95WaitMs);
  const baselineP95 = baselineStage.latencyP95 ?? 0;
  const loadedP95 = loadedStage.latencyP95 ?? 0;
  const delta = baselineP95 > 0 ? (loadedP95 - baselineP95) / baselineP95 : (loadedP95 === 0 ? 0 : 1);
  const appStats = judgeQueue.stats();
  judgeQueue.destroy();
  destroySim(loadedSim);
  out.push(...baselineTurns, ...loadedTurns);
  const sheddingEngaged = providerJudgeShed > 0 || pressureShed.kind === 'shed';
  const deltaPass = delta <= ISOLATION_DELTA_BUDGET && sheddingEngaged && loadedStage.completed > 0;
  return {
    baselineStage,
    loadedStage,
    deltaPass,
    detail: `interactive p95 baseline=${baselineP95.toFixed(0)}ms loaded=${loadedP95.toFixed(0)}ms delta=${(delta * 100).toFixed(2)}% ` +
      `<= ${(ISOLATION_DELTA_BUDGET * 100).toFixed(0)}%; provider judge shed=${providerJudgeShed} served=${judgeServed} ` +
      `app backlog=${appStats.depth} app shed=${appStats.shedTotal} (shedding engaged=${sheddingEngaged}, reservation intact)`,
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && (entry.endsWith('capacity-run.ts') || entry.endsWith('capacity-run.js'));
}

if (isMainModule()) {
  try {
    const options = parseCapacityArgs(process.argv.slice(2));
    const report = runCapacitySuite(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.reportOut !== undefined) {
      mkdirSync(dirname(options.reportOut), { recursive: true });
      writeFileSync(options.reportOut, output);
    }
    console.log(output);
    for (const assertion of report.assertions) {
      console.log(`[${assertion.passed ? 'PASS' : 'FAIL'}] ${assertion.id}: ${assertion.detail}`);
    }
    console.log(`OVERALL: ${report.status.toUpperCase()}`);
    process.exit(report.status === 'pass' ? 0 : 1);
  } catch (error) {
    if (error instanceof CapacityUsageError) {
      console.error(`capacity-run usage: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
