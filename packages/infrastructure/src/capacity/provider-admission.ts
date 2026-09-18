import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Global and per-provider admission with circuit breakers (WP-8, F-35/F-41).
 *
 * Vercel can accept more concurrent functions than the model providers can
 * serve. This module protects the scarcest downstream resource:
 *
 * - Global and per-provider concurrency ceilings with separate interactive
 *   reservations: background/judge work can never consume the interactive
 *   reservation and is shed first.
 * - Per-provider fixed-window rate accounting (requests/minute).
 * - Circuit breakers per provider/dependency with closed/open/half-open
 *   transitions driven by throttle (429), server (5xx), timeout, and network
 *   failures, plus explicit load-shedding signals (DB pool wait, Redis
 *   errors, deadline-miss rate).
 * - Typed rejections with explicit Retry-After, returned *before* the caller
 *   starts embeddings or model work.
 *
 * All clocks are injectable for deterministic virtual-clock tests.
 */

export const ProviderNameSchema = z.enum(['main', 'planner', 'grader', 'embedding', 'reranker']);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const TrafficKindSchema = z.enum(['interactive', 'background']);
export type TrafficKind = z.infer<typeof TrafficKindSchema>;

export const ProviderFailureKindSchema = z.enum(['throttle_429', 'server_5xx', 'timeout', 'network']);
export type ProviderFailureKind = z.infer<typeof ProviderFailureKindSchema>;

export const CircuitStateSchema = z.enum(['closed', 'open', 'half_open']);
export type CircuitState = z.infer<typeof CircuitStateSchema>;

export const ProviderRejectCategorySchema = z.enum([
  'global_saturated',
  'provider_saturated',
  'interactive_reserve',
  'circuit_open',
  'rate_limited',
  'dependency_shedding',
]);
export type ProviderRejectCategory = z.infer<typeof ProviderRejectCategorySchema>;

export type ProviderAcquireDecision =
  | { readonly kind: 'admitted'; readonly provider: ProviderName; readonly inFlight: number }
  | {
      readonly kind: 'rejected';
      readonly category: ProviderRejectCategory;
      readonly retryAfterMs: number;
      readonly message: string;
      readonly shedBeforeWork: true;
    };

export const ProviderAdmissionConfigSchema = z.object({
  globalMax: z.number().int().min(1).max(100_000),
  perProviderMax: z.record(ProviderNameSchema, z.number().int().min(1).max(100_000)),
  /** In-flight slots reserved for interactive traffic; background cannot use them. */
  interactiveReserve: z.number().int().min(0).max(100_000),
  perProviderRatePerMinute: z.record(ProviderNameSchema, z.number().int().min(1).max(10_000_000)),
  circuitFailureThreshold: z.number().int().min(1).max(1_000),
  circuitResetMs: z.number().int().min(100).max(600_000),
  halfOpenMaxProbes: z.number().int().min(1).max(100),
  defaultRetryAfterMs: z.number().int().min(0).max(600_000),
});
export type ProviderAdmissionConfig = z.infer<typeof ProviderAdmissionConfigSchema>;

export const DEFAULT_PROVIDER_ADMISSION_CONFIG: ProviderAdmissionConfig = Object.freeze({
  globalMax: 4_000,
  perProviderMax: Object.freeze({
    main: 4_000,
    planner: 2_000,
    grader: 500,
    embedding: 2_000,
    reranker: 2_000,
  }),
  interactiveReserve: 500,
  perProviderRatePerMinute: Object.freeze({
    main: 60_000,
    planner: 30_000,
    grader: 6_000,
    embedding: 30_000,
    reranker: 30_000,
  }),
  circuitFailureThreshold: 20,
  circuitResetMs: 30_000,
  halfOpenMaxProbes: 2,
  defaultRetryAfterMs: 1_000,
});

interface Circuit {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number;
  halfOpenProbes: number;
}

export interface ProviderAdmissionOptions {
  readonly config?: ProviderAdmissionConfig | undefined;
  readonly now?: (() => number) | undefined;
}

export function resolveProviderAdmissionConfig(input: unknown): ProviderAdmissionConfig {
  const parsed = ProviderAdmissionConfigSchema.partial().parse(input ?? {});
  const fallback = DEFAULT_PROVIDER_ADMISSION_CONFIG;
  return Object.freeze({
    globalMax: parsed.globalMax ?? fallback.globalMax,
    perProviderMax: Object.freeze({ ...fallback.perProviderMax, ...parsed.perProviderMax }),
    interactiveReserve: parsed.interactiveReserve ?? fallback.interactiveReserve,
    perProviderRatePerMinute: Object.freeze({ ...fallback.perProviderRatePerMinute, ...parsed.perProviderRatePerMinute }),
    circuitFailureThreshold: parsed.circuitFailureThreshold ?? fallback.circuitFailureThreshold,
    circuitResetMs: parsed.circuitResetMs ?? fallback.circuitResetMs,
    halfOpenMaxProbes: parsed.halfOpenMaxProbes ?? fallback.halfOpenMaxProbes,
    defaultRetryAfterMs: parsed.defaultRetryAfterMs ?? fallback.defaultRetryAfterMs,
  });
}

export class ProviderAdmission {
  private readonly config: ProviderAdmissionConfig;
  private readonly now: () => number;
  private readonly inFlight = new Map<ProviderName, number>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly shedding = new Map<string, boolean>();
  private readonly rateWindows = new Map<ProviderName, { windowStartMs: number; count: number }>();
  private globalInFlight = 0;
  private destroyed = false;

  constructor(options: ProviderAdmissionOptions = {}) {
    this.config = options.config ?? DEFAULT_PROVIDER_ADMISSION_CONFIG;
    this.now = options.now ?? Date.now;
    const providers: readonly ProviderName[] = ['main', 'planner', 'grader', 'embedding', 'reranker'];
    for (const provider of providers) {
      this.inFlight.set(provider, 0);
      this.circuits.set(this.circuitKey(provider), this.freshCircuit());
      this.rateWindows.set(provider, { windowStartMs: 0, count: 0 });
    }
    for (const dep of ['db', 'redis'] as const) {
      this.circuits.set(dep, this.freshCircuit());
      this.shedding.set(dep, false);
    }
  }

  tryAcquire(input: { readonly provider: ProviderName; readonly kind: TrafficKind }): ProviderAcquireDecision {
    this.throwIfDestroyed();
    const parsed = z.object({ provider: ProviderNameSchema, kind: TrafficKindSchema }).parse(input);
    const nowMs = this.now();
    const circuit = this.circuitFor(this.circuitKey(parsed.provider));
    this.advanceCircuit(circuit, nowMs);

    if (circuit.state === 'open') {
      return this.reject('circuit_open',
        Math.max(0, circuit.openedAtMs + this.config.circuitResetMs - nowMs),
        `Provider ${parsed.provider} circuit is open; shedding before model work.`);
    }
    if (circuit.state === 'half_open' && circuit.halfOpenProbes >= this.config.halfOpenMaxProbes) {
      return this.reject('circuit_open', this.config.circuitResetMs,
        `Provider ${parsed.provider} half-open probes exhausted; shedding.`);
    }

    if (this.isDependencyShedding() && parsed.kind === 'background') {
      return this.reject('dependency_shedding', this.config.defaultRetryAfterMs,
        'Background provider work is shed while a dependency is degraded.');
    }

    const window = this.rateWindows.get(parsed.provider) ?? { windowStartMs: nowMs, count: 0 };
    const windowStart = Math.floor(nowMs / 60_000) * 60_000;
    if (window.windowStartMs !== windowStart) {
      window.windowStartMs = windowStart;
      window.count = 0;
    }
    const rateLimit = this.config.perProviderRatePerMinute[parsed.provider];
    if (window.count >= rateLimit) {
      return this.reject('rate_limited', Math.max(0, windowStart + 60_000 - nowMs),
        `Provider ${parsed.provider} minute rate exhausted.`);
    }

    const providerCount = this.inFlight.get(parsed.provider) ?? 0;
    const providerMax = this.config.perProviderMax[parsed.provider];
    if (parsed.kind === 'background' && providerCount >= providerMax - this.config.interactiveReserve) {
      return this.reject('interactive_reserve', this.config.defaultRetryAfterMs,
        'Background work refused to preserve the interactive provider reservation.');
    }
    if (providerCount >= providerMax) {
      return this.reject('provider_saturated', this.config.defaultRetryAfterMs,
        `Provider ${parsed.provider} concurrency saturated.`);
    }
    if (this.globalInFlight >= this.config.globalMax) {
      return this.reject('global_saturated', this.config.defaultRetryAfterMs,
        'Global provider admission saturated.');
    }

    window.count += 1;
    this.rateWindows.set(parsed.provider, window);
    this.inFlight.set(parsed.provider, providerCount + 1);
    this.globalInFlight += 1;
    if (circuit.state === 'half_open') circuit.halfOpenProbes += 1;
    logger.info('capacity.provider.admitted', { provider: parsed.provider, kind: parsed.kind });
    return Object.freeze({ kind: 'admitted', provider: parsed.provider, inFlight: providerCount + 1 });
  }

  release(provider: ProviderName): void {
    this.throwIfDestroyed();
    const count = this.inFlight.get(provider) ?? 0;
    this.inFlight.set(provider, Math.max(0, count - 1));
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
  }

  recordSuccess(provider: ProviderName): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(this.circuitKey(provider));
    circuit.consecutiveFailures = 0;
    if (circuit.state === 'half_open') {
      circuit.state = 'closed';
      circuit.halfOpenProbes = 0;
      logger.info('capacity.provider.circuit_closed', { provider });
    }
  }

  recordFailure(provider: ProviderName, kind: ProviderFailureKind): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(this.circuitKey(provider));
    circuit.consecutiveFailures += 1;
    logger.warn('capacity.provider.failure', {
      provider,
      failureKind: kind,
      consecutiveFailures: circuit.consecutiveFailures,
    });
    if (kind === 'throttle_429' || kind === 'server_5xx' || kind === 'timeout') {
      if (circuit.consecutiveFailures >= this.config.circuitFailureThreshold && circuit.state !== 'open') {
        circuit.state = 'open';
        circuit.openedAtMs = this.now();
        circuit.halfOpenProbes = 0;
        logger.warn('capacity.provider.circuit_open', { provider });
      }
    }
  }

  reportPoolWait(waitMs: number): void {
    this.throwIfDestroyed();
    if (!Number.isFinite(waitMs) || waitMs < 0) return;
    if (waitMs >= 100) {
      this.recordDependencyFailure('db', 'timeout');
    } else {
      this.recordDependencySuccess('db');
    }
  }

  reportRedisError(): void {
    this.throwIfDestroyed();
    this.recordDependencyFailure('redis', 'error');
  }

  reportDeadlineMiss(): void {
    this.throwIfDestroyed();
    this.shedding.set('db', true);
    logger.warn('capacity.provider.deadline_miss_shedding', {});
  }

  recordDependencySuccess(dep: 'db' | 'redis'): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(dep);
    circuit.consecutiveFailures = 0;
    if (circuit.state === 'half_open') {
      circuit.state = 'closed';
      circuit.halfOpenProbes = 0;
    }
    this.shedding.set(dep, false);
  }

  recordDependencyFailure(dep: 'db' | 'redis', kind: 'throttle' | 'error' | 'timeout'): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(dep);
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= this.config.circuitFailureThreshold && circuit.state === 'closed') {
      circuit.state = 'open';
      circuit.openedAtMs = this.now();
      circuit.halfOpenProbes = 0;
      logger.warn('capacity.provider.dependency_circuit_open', { dependency: dep });
    }
    if (kind === 'timeout' || kind === 'error') this.shedding.set(dep, true);
  }

  circuitState(provider: ProviderName): CircuitState {
    const circuit = this.circuitFor(this.circuitKey(provider));
    this.advanceCircuit(circuit, this.now());
    return circuit.state;
  }

  stats(): {
    readonly globalInFlight: number;
    readonly globalMax: number;
    readonly perProvider: Readonly<Record<ProviderName, number>>;
    readonly circuits: Readonly<Record<string, CircuitState>>;
    readonly shedding: Readonly<Record<string, boolean>>;
  } {
    const perProvider = {
      main: this.inFlight.get('main') ?? 0,
      planner: this.inFlight.get('planner') ?? 0,
      grader: this.inFlight.get('grader') ?? 0,
      embedding: this.inFlight.get('embedding') ?? 0,
      reranker: this.inFlight.get('reranker') ?? 0,
    } as const;
    const circuits: Record<string, CircuitState> = {};
    for (const [key, circuit] of this.circuits) circuits[key] = circuit.state;
    const shedding: Record<string, boolean> = {};
    for (const [key, value] of this.shedding) shedding[key] = value;
    return Object.freeze({
      globalInFlight: this.globalInFlight,
      globalMax: this.config.globalMax,
      perProvider: Object.freeze(perProvider),
      circuits: Object.freeze(circuits),
      shedding: Object.freeze(shedding),
    });
  }

  destroy(): void {
    this.inFlight.clear();
    this.circuits.clear();
    this.shedding.clear();
    this.rateWindows.clear();
    this.destroyed = true;
  }

  private circuitKey(provider: ProviderName): string {
    return `provider:${provider}`;
  }

  private freshCircuit(): Circuit {
    return { state: 'closed', consecutiveFailures: 0, openedAtMs: 0, halfOpenProbes: 0 };
  }

  private circuitFor(key: string): Circuit {
    const circuit = this.circuits.get(key);
    if (circuit === undefined) throw new Error(`provider-admission: unknown circuit ${key}`);
    return circuit;
  }

  private advanceCircuit(circuit: Circuit, nowMs: number): void {
    if (circuit.state === 'open' && nowMs - circuit.openedAtMs >= this.config.circuitResetMs) {
      circuit.state = 'half_open';
      circuit.halfOpenProbes = 0;
      logger.info('capacity.provider.circuit_half_open', {});
    }
  }

  private isDependencyShedding(): boolean {
    return (this.shedding.get('db') ?? false) || (this.shedding.get('redis') ?? false);
  }

  private reject(category: ProviderRejectCategory, retryAfterMs: number, message: string): ProviderAcquireDecision {
    logger.warn('capacity.provider.rejected', { category, retryAfterMs });
    return Object.freeze({
      kind: 'rejected',
      category,
      retryAfterMs: Math.max(0, Math.floor(retryAfterMs)),
      message,
      shedBeforeWork: true as const,
    });
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('provider-admission: instance destroyed');
  }
}
