import { z } from 'zod';
import { logger } from '@app/domain';
import { randomUUID } from 'node:crypto';

/**
 * Application-layer admission policy (WP-8, F-35/F-41).
 *
 * This module owns the admission *policy*: per-user concurrency, global and
 * per-provider ceilings, a bounded priority queue with deadlines, circuit
 * breakers, and typed rejections with explicit Retry-After. It never performs
 * expensive work itself; every rejection happens before embeddings, model
 * calls, or database access.
 *
 * Layering: this module is provider-neutral and imports only zod, domain, and
 * node:crypto. Distributed correctness across Fluid instances comes from an
 * injected {@link DistributedTurnLeasePort} (implemented in infrastructure).
 * The process-local maps below are a fast-path optimization only: when a
 * distributed port is present, a local admit is rolled back unless the
 * distributed lease is also acquired.
 *
 * Ordering invariants (auth/tenant isolation/rate limits/idempotency are
 * preserved, never bypassed):
 * - Authentication, tenant scoping, rate limiting, and request idempotency
 *   run *before* admission. Admission keys are tenant-scoped and a repeated
 *   admit for the same turnId is idempotent (returns the same lease).
 * - Rejections are typed and carry an explicit retryAfterMs so callers can
 *   answer 429/503 truthfully instead of resetting the connection.
 */

export const ProviderRoleSchema = z.enum(['main', 'planner', 'grader', 'embedding', 'reranker']);
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;

export const AdmissionKindSchema = z.enum(['interactive', 'background']);
export type AdmissionKind = z.infer<typeof AdmissionKindSchema>;

export const AdmissionRejectionReasonSchema = z.enum([
  'per_user_limit',
  'global_limit',
  'provider_limit',
  'queue_full',
  'queue_timeout',
  'circuit_open',
  'dependency_shedding',
  'deadline_exceeded',
  'rate_limited',
]);
export type AdmissionRejectionReason = z.infer<typeof AdmissionRejectionReasonSchema>;

export const ReleaseOutcomeSchema = z.enum([
  'completed',
  'cancelled',
  'disconnected',
  'timeout',
  'error',
  'expired',
]);
export type ReleaseOutcome = z.infer<typeof ReleaseOutcomeSchema>;

export const AdmissionRequestSchema = z.object({
  userId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200).optional(),
  turnId: z.string().min(1).max(200),
  provider: ProviderRoleSchema,
  kind: AdmissionKindSchema,
  deadlineAtMs: z.number().int().nonnegative().optional(),
  queueable: z.boolean().optional(),
});
export type AdmissionRequest = z.infer<typeof AdmissionRequestSchema>;

export const AdmissionConfigSchema = z.object({
  maxConcurrentPerUser: z.number().int().min(1).max(16).default(2),
  globalMaxConcurrent: z.number().int().min(1).max(100_000).default(4_000),
  providerMax: z.record(ProviderRoleSchema, z.number().int().min(1).max(100_000)).default({
    main: 4_000,
    planner: 2_000,
    grader: 500,
    embedding: 2_000,
    reranker: 2_000,
  }),
  queueMax: z.number().int().min(0).max(10_000).default(512),
  queueDeadlineMs: z.number().int().min(0).max(120_000).default(5_000),
  queueReserveMs: z.number().int().min(0).max(30_000).default(500),
  leaseTtlMs: z.number().int().min(1_000).max(600_000).default(120_000),
  circuitFailureThreshold: z.number().int().min(1).max(100).default(20),
  circuitResetMs: z.number().int().min(100).max(600_000).default(30_000),
  defaultRetryAfterMs: z.number().int().min(0).max(600_000).default(1_000),
  poolWaitShedThresholdMs: z.number().int().min(1).max(60_000).default(100),
  poolWaitShedStreak: z.number().int().min(1).max(100).default(5),
});
export type AdmissionConfig = z.infer<typeof AdmissionConfigSchema>;

export const DEFAULT_ADMISSION_CONFIG: AdmissionConfig = Object.freeze({
  maxConcurrentPerUser: 2,
  globalMaxConcurrent: 4_000,
  providerMax: Object.freeze({
    main: 4_000,
    planner: 2_000,
    grader: 500,
    embedding: 2_000,
    reranker: 2_000,
  }),
  queueMax: 512,
  queueDeadlineMs: 5_000,
  queueReserveMs: 500,
  leaseTtlMs: 120_000,
  circuitFailureThreshold: 20,
  circuitResetMs: 30_000,
  defaultRetryAfterMs: 1_000,
  poolWaitShedThresholdMs: 100,
  poolWaitShedStreak: 5,
});

export function resolveAdmissionConfig(input: unknown): AdmissionConfig {
  const parsed = AdmissionConfigSchema.parse(input ?? {});
  return Object.freeze({ ...parsed, providerMax: Object.freeze({ ...parsed.providerMax }) });
}

export type AdmittedDecision = {
  readonly kind: 'admitted';
  readonly leaseId: string;
  readonly ownerToken: string;
  readonly expiresAtMs: number;
  readonly queueWaitMs: number;
  readonly viaQueue: boolean;
};

export type RejectedDecision = {
  readonly kind: 'rejected';
  readonly reason: AdmissionRejectionReason;
  readonly retryAfterMs: number;
  readonly message: string;
  /** Always true: admission rejects before embeddings/model/DB work starts. */
  readonly shedBeforeExpensiveWork: true;
};

export type QueuedDecision = {
  readonly kind: 'queued';
  readonly turnId: string;
  readonly position: number;
  readonly queueDeadlineMs: number;
  readonly retryAfterMs: number;
};

export type AdmissionDecision = AdmittedDecision | RejectedDecision | QueuedDecision;

export type ReleaseLeaseResult =
  | { readonly kind: 'released'; readonly outcome: ReleaseOutcome }
  | { readonly kind: 'already_released'; readonly leaseId: string }
  | { readonly kind: 'unknown_lease'; readonly leaseId: string }
  | { readonly kind: 'token_mismatch'; readonly leaseId: string };

export type DependencyName = 'provider' | 'db' | 'redis';
export type DependencyFailureKind = 'throttle' | 'error' | 'timeout';

type CircuitState = 'closed' | 'open' | 'half_open';

interface Circuit {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number;
  halfOpenProbes: number;
}

interface ActiveLease {
  readonly leaseId: string;
  readonly ownerToken: string;
  readonly scopeKey: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly turnId: string;
  readonly provider: ProviderRole;
  readonly kind: AdmissionKind;
  readonly expiresAtMs: number;
  readonly distributedToken: string | null;
}

interface QueueEntry {
  readonly request: AdmissionRequest;
  readonly enqueuedAtMs: number;
  readonly deadlineMs: number;
  readonly seq: number;
}

/**
 * Distributed lease port satisfied by infrastructure (Redis-backed). The
 * controller treats the local maps as a fast path and requires the
 * distributed acquire to succeed before reporting admission.
 */
export interface DistributedTurnLeasePort {
  readonly isDistributed: boolean;
  acquire(input: {
    readonly scopeKey: string;
    readonly turnId: string;
    readonly ttlMs: number;
    readonly maxPerUser: number;
    readonly nowMs: number;
  }): { readonly acquired: boolean; readonly ownerToken?: string | undefined; readonly retryAfterMs?: number | undefined };
  release(input: {
    readonly scopeKey: string;
    readonly turnId: string;
    readonly ownerToken: string;
  }): boolean;
}

export interface AdmissionControllerOptions {
  readonly config?: AdmissionConfig | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly distributed?: DistributedTurnLeasePort | undefined;
  /** Fail closed when the distributed store is unavailable (default true). */
  readonly failClosedOnDistributedOutage?: boolean | undefined;
}

function scopeKeyFor(tenantId: string | undefined, userId: string): string {
  return `${tenantId ?? 'default'}\n${userId}`;
}

const SAFE_RETRY_AFTER_CAP_MS = 60_000;

export class AdmissionController {
  private readonly config: AdmissionConfig;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly distributed: DistributedTurnLeasePort | undefined;
  private readonly failClosed: boolean;
  private readonly activeByLease = new Map<string, ActiveLease>();
  private readonly activeByTurn = new Map<string, string>();
  private readonly userCounts = new Map<string, number>();
  private readonly providerActive = new Map<ProviderRole, number>();
  private queue: QueueEntry[] = [];
  private seq = 0;
  private readonly circuits = new Map<DependencyName, Circuit>();
  private readonly shedding = new Map<DependencyName, boolean>();
  private readonly releasedLog = new Map<string, string>();
  private readonly outcomeCounts = new Map<ReleaseOutcome, number>();
  private admittedTotal = 0;
  private rejectedTotal = 0;
  private queuedTotal = 0;
  private destroyed = false;

  constructor(options: AdmissionControllerOptions = {}) {
    this.config = options.config ?? DEFAULT_ADMISSION_CONFIG;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.distributed = options.distributed;
    this.failClosed = options.failClosedOnDistributedOutage ?? true;
    const roles: readonly ProviderRole[] = ['main', 'planner', 'grader', 'embedding', 'reranker'];
    for (const role of roles) this.providerActive.set(role, 0);
    const deps: readonly DependencyName[] = ['provider', 'db', 'redis'];
    for (const dep of deps) {
      this.circuits.set(dep, { state: 'closed', consecutiveFailures: 0, openedAtMs: 0, halfOpenProbes: 0 });
      this.shedding.set(dep, false);
    }
  }

  tryAdmit(raw: unknown): AdmissionDecision {
    this.throwIfDestroyed();
    const request = AdmissionRequestSchema.parse(raw);
    const nowMs = this.now();
    this.purgeExpired(nowMs);

    const queueable = request.queueable ?? true;
    const tenantId = request.tenantId ?? 'default';

    if (request.deadlineAtMs !== undefined && request.deadlineAtMs <= nowMs) {
      return this.reject('deadline_exceeded', 0, 'Turn deadline already elapsed; not starting work.');
    }

    const existingLeaseId = this.activeByTurn.get(request.turnId);
    if (existingLeaseId !== undefined) {
      const existing = this.activeByLease.get(existingLeaseId);
      if (existing !== undefined && existing.scopeKey === scopeKeyFor(request.tenantId, request.userId)) {
        return {
          kind: 'admitted',
          leaseId: existing.leaseId,
          ownerToken: existing.ownerToken,
          expiresAtMs: existing.expiresAtMs,
          queueWaitMs: 0,
          viaQueue: false,
        };
      }
    }

    const circuit = this.circuitFor('provider');
    this.advanceCircuit('provider', circuit, nowMs);
    if (circuit.state === 'open') {
      const retryAfterMs = Math.max(0, circuit.openedAtMs + this.config.circuitResetMs - nowMs);
      return this.reject('circuit_open', retryAfterMs, 'Provider circuit is open; shedding before model work.');
    }

    if (this.isShedding() && request.kind === 'background') {
      return this.reject(
        'dependency_shedding',
        this.config.defaultRetryAfterMs,
        'Background work is shed while a dependency is degraded; interactive traffic is preserved.',
      );
    }

    const scopeKey = scopeKeyFor(request.tenantId, request.userId);
    const userActive = this.userCounts.get(scopeKey) ?? 0;
    if (userActive >= this.config.maxConcurrentPerUser) {
      return this.queueOrReject(request, 'per_user_limit', this.config.defaultRetryAfterMs,
        `Per-user active-turn limit reached (${this.config.maxConcurrentPerUser}).`, queueable, nowMs);
    }

    if (this.activeByLease.size >= this.config.globalMaxConcurrent) {
      return this.queueOrReject(request, 'global_limit', this.config.defaultRetryAfterMs,
        'Global admission limit reached; shedding before expensive work.', queueable, nowMs);
    }

    const providerCount = this.providerActive.get(request.provider) ?? 0;
    const providerMax = this.config.providerMax[request.provider];
    if (providerCount >= providerMax) {
      return this.queueOrReject(request, 'provider_limit', this.config.defaultRetryAfterMs,
        `Provider ${request.provider} admission limit reached.`, queueable, nowMs);
    }

    const distributedToken = this.acquireDistributed(scopeKey, request, nowMs);
    if (distributedToken === null) {
      return this.reject('per_user_limit', this.config.defaultRetryAfterMs,
        'Distributed per-user turn lease unavailable or exhausted.');
    }

    const leaseId = this.newId();
    const lease: ActiveLease = {
      leaseId,
      ownerToken: this.newId(),
      scopeKey,
      userId: request.userId,
      tenantId,
      turnId: request.turnId,
      provider: request.provider,
      kind: request.kind,
      expiresAtMs: nowMs + this.config.leaseTtlMs,
      distributedToken,
    };
    this.activeByLease.set(leaseId, lease);
    this.activeByTurn.set(request.turnId, leaseId);
    this.userCounts.set(scopeKey, userActive + 1);
    this.providerActive.set(request.provider, providerCount + 1);
    this.admittedTotal += 1;
    logger.info('capacity.admission.admitted', {
      leaseId,
      turnId: request.turnId,
      provider: request.provider,
      kind: request.kind,
      viaQueue: false,
    });
    return {
      kind: 'admitted',
      leaseId,
      ownerToken: lease.ownerToken,
      expiresAtMs: lease.expiresAtMs,
      queueWaitMs: 0,
      viaQueue: false,
    };
  }

  /**
   * Promote queued requests while capacity allows. Expired queue entries are
   * reported as typed queue_timeout rejections (never silently dropped).
   */
  pumpQueue(nowMs?: number): { readonly admitted: readonly AdmittedDecision[]; readonly expired: readonly RejectedDecision[] } {
    this.throwIfDestroyed();
    const now = nowMs ?? this.now();
    this.purgeExpired(now);
    const admitted: AdmittedDecision[] = [];
    const expired: RejectedDecision[] = [];
    const remaining: QueueEntry[] = [];
    const ordered = [...this.queue].sort((a, b) => {
      const aInteractive = a.request.kind === 'interactive' ? 0 : 1;
      const bInteractive = b.request.kind === 'interactive' ? 0 : 1;
      if (aInteractive !== bInteractive) return aInteractive - bInteractive;
      return a.seq - b.seq;
    });
    this.queue = [];
    for (const entry of ordered) {
      if (entry.deadlineMs <= now) {
        expired.push(this.reject('queue_timeout', 0, 'Queued turn exceeded its queue deadline.'));
        logger.warn('capacity.admission.queue_timeout', { turnId: entry.request.turnId });
        continue;
      }
      const decision = this.tryAdmit({ ...entry.request, queueable: false });
      if (decision.kind === 'admitted') {
        admitted.push({ ...decision, queueWaitMs: now - entry.enqueuedAtMs, viaQueue: true });
      } else if (decision.kind === 'rejected' && this.isCapacityReason(decision.reason)) {
        remaining.push(entry);
      } else {
        expired.push(decision.kind === 'rejected' ? decision : this.reject('queue_timeout', 0, 'Queued turn cannot proceed.'));
      }
    }
    this.queue = [...remaining, ...this.queue];
    return { admitted: Object.freeze(admitted), expired: Object.freeze(expired) };
  }

  /** Exactly-once release. Safe to call for completed/cancelled/disconnected/timeout/error paths. */
  release(input: { readonly leaseId: string; readonly ownerToken: string; readonly outcome: ReleaseOutcome }): ReleaseLeaseResult {
    this.throwIfDestroyed();
    const parsed = z.object({
      leaseId: z.string().min(1),
      ownerToken: z.string().min(1),
      outcome: ReleaseOutcomeSchema,
    }).parse(input);
    const active = this.activeByLease.get(parsed.leaseId);
    if (active === undefined) {
      if (this.releasedLog.has(parsed.leaseId)) {
        return { kind: 'already_released', leaseId: parsed.leaseId };
      }
      return { kind: 'unknown_lease', leaseId: parsed.leaseId };
    }
    if (active.ownerToken !== parsed.ownerToken) {
      logger.warn('capacity.admission.release_token_mismatch', { leaseId: parsed.leaseId });
      return { kind: 'token_mismatch', leaseId: parsed.leaseId };
    }
    this.removeLease(active);
    this.recordOutcome(parsed.outcome);
    this.releaseDistributed(active);
    logger.info('capacity.admission.released', { leaseId: parsed.leaseId, outcome: parsed.outcome });
    this.pumpQueue();
    return { kind: 'released', outcome: parsed.outcome };
  }

  /**
   * Disconnect/cancel path: frees the permit by turnId even when the caller
   * lost the leaseId (client disconnect, stream abort). Ownership token is
   * enforced when supplied.
   */
  releaseByTurn(input: { readonly turnId: string; readonly ownerToken?: string | undefined; readonly outcome: ReleaseOutcome }): boolean {
    this.throwIfDestroyed();
    const parsed = z.object({
      turnId: z.string().min(1),
      ownerToken: z.string().min(1).optional(),
      outcome: ReleaseOutcomeSchema,
    }).parse(input);
    const leaseId = this.activeByTurn.get(parsed.turnId);
    if (leaseId === undefined) return false;
    const active = this.activeByLease.get(leaseId);
    if (active === undefined) return false;
    if (parsed.ownerToken !== undefined && active.ownerToken !== parsed.ownerToken) {
      logger.warn('capacity.admission.release_token_mismatch', { leaseId });
      return false;
    }
    this.removeLease(active);
    this.recordOutcome(parsed.outcome);
    this.releaseDistributed(active);
    logger.info('capacity.admission.released', { leaseId, outcome: parsed.outcome, byTurn: true });
    this.pumpQueue();
    return true;
  }

  /** Pre-work gate: call before embeddings/model/DB work. Returns a rejection when the work must not start. */
  shedBeforeExpensiveWork(input: {
    readonly provider: ProviderRole;
    readonly kind: AdmissionKind;
    readonly deadlineAtMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  }): RejectedDecision | null {
    this.throwIfDestroyed();
    const nowMs = this.now();
    if (input.signal?.aborted) {
      return this.reject('deadline_exceeded', 0, 'Caller cancelled before expensive work started.');
    }
    if (input.deadlineAtMs !== undefined && input.deadlineAtMs <= nowMs) {
      return this.reject('deadline_exceeded', 0, 'Deadline elapsed before expensive work started.');
    }
    const circuit = this.circuitFor('provider');
    this.advanceCircuit('provider', circuit, nowMs);
    if (circuit.state === 'open') {
      return this.reject('circuit_open',
        Math.max(0, circuit.openedAtMs + this.config.circuitResetMs - nowMs),
        'Shedding expensive work while the provider circuit is open.');
    }
    if (this.isShedding() && input.kind === 'background') {
      return this.reject('dependency_shedding', this.config.defaultRetryAfterMs,
        'Shedding background work while a dependency is degraded.');
    }
    const providerCount = this.providerActive.get(input.provider) ?? 0;
    if (providerCount >= this.config.providerMax[input.provider]) {
      return this.reject('provider_limit', this.config.defaultRetryAfterMs,
        `Provider ${input.provider} saturated; not starting expensive work.`);
    }
    return null;
  }

  recordDependencySuccess(dep: DependencyName): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(dep);
    circuit.consecutiveFailures = 0;
    if (circuit.state === 'half_open') {
      circuit.state = 'closed';
      circuit.halfOpenProbes = 0;
      logger.info('capacity.admission.circuit_closed', { dependency: dep });
    }
    if (dep !== 'provider') this.shedding.set(dep, false);
  }

  recordDependencyFailure(dep: DependencyName, kind: DependencyFailureKind): void {
    this.throwIfDestroyed();
    const circuit = this.circuitFor(dep);
    circuit.consecutiveFailures += 1;
    logger.warn('capacity.admission.dependency_failure', {
      dependency: dep,
      failureKind: kind,
      consecutiveFailures: circuit.consecutiveFailures,
    });
    if (circuit.consecutiveFailures >= this.config.circuitFailureThreshold && circuit.state === 'closed') {
      circuit.state = 'open';
      circuit.openedAtMs = this.now();
      circuit.halfOpenProbes = 0;
      logger.warn('capacity.admission.circuit_open', { dependency: dep });
    }
    if (dep !== 'provider' && (kind === 'timeout' || kind === 'error')) {
      this.shedding.set(dep, true);
    }
  }

  reportPoolWait(waitMs: number): void {
    this.throwIfDestroyed();
    if (!Number.isFinite(waitMs) || waitMs < 0) return;
    if (waitMs >= this.config.poolWaitShedThresholdMs) {
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
    this.recordDependencyFailure('provider', 'timeout');
  }

  setShedding(dep: DependencyName, shedding: boolean): void {
    this.throwIfDestroyed();
    this.shedding.set(dep, shedding);
  }

  circuitState(dep: DependencyName): CircuitState {
    const circuit = this.circuitFor(dep);
    this.advanceCircuit(dep, circuit, this.now());
    return circuit.state;
  }

  purgeExpired(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let recovered = 0;
    for (const lease of [...this.activeByLease.values()]) {
      if (lease.expiresAtMs <= now) {
        this.removeLease(lease);
        this.recordOutcome('expired');
        this.releaseDistributed(lease);
        recovered += 1;
        logger.warn('capacity.admission.lease_expired_recovered', {
          leaseId: lease.leaseId,
          turnId: lease.turnId,
        });
      }
    }
    return recovered;
  }

  stats(): {
    readonly active: number;
    readonly distinctUsers: number;
    readonly queueDepth: number;
    readonly queueMax: number;
    readonly admittedTotal: number;
    readonly rejectedTotal: number;
    readonly queuedTotal: number;
    readonly providerActive: Readonly<Record<ProviderRole, number>>;
    readonly circuits: Readonly<Record<DependencyName, CircuitState>>;
    readonly shedding: Readonly<Record<DependencyName, boolean>>;
    readonly outcomes: Readonly<Record<ReleaseOutcome, number>>;
  } {
    const providerActive = {
      main: this.providerActive.get('main') ?? 0,
      planner: this.providerActive.get('planner') ?? 0,
      grader: this.providerActive.get('grader') ?? 0,
      embedding: this.providerActive.get('embedding') ?? 0,
      reranker: this.providerActive.get('reranker') ?? 0,
    } as const;
    const circuits = {
      provider: this.circuitFor('provider').state,
      db: this.circuitFor('db').state,
      redis: this.circuitFor('redis').state,
    } as const;
    const shedding = {
      provider: this.shedding.get('provider') ?? false,
      db: this.shedding.get('db') ?? false,
      redis: this.shedding.get('redis') ?? false,
    } as const;
    const outcomes: Record<ReleaseOutcome, number> = {
      completed: this.outcomeCounts.get('completed') ?? 0,
      cancelled: this.outcomeCounts.get('cancelled') ?? 0,
      disconnected: this.outcomeCounts.get('disconnected') ?? 0,
      timeout: this.outcomeCounts.get('timeout') ?? 0,
      error: this.outcomeCounts.get('error') ?? 0,
      expired: this.outcomeCounts.get('expired') ?? 0,
    };
    return Object.freeze({
      active: this.activeByLease.size,
      distinctUsers: this.userCounts.size,
      queueDepth: this.queue.length,
      queueMax: this.config.queueMax,
      admittedTotal: this.admittedTotal,
      rejectedTotal: this.rejectedTotal,
      queuedTotal: this.queuedTotal,
      providerActive: Object.freeze(providerActive),
      circuits: Object.freeze(circuits),
      shedding: Object.freeze(shedding),
      outcomes: Object.freeze(outcomes),
    });
  }

  destroy(): void {
    this.activeByLease.clear();
    this.activeByTurn.clear();
    this.userCounts.clear();
    this.queue = [];
    this.releasedLog.clear();
    this.destroyed = true;
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('admission-control: controller destroyed');
  }

  private circuitFor(dep: DependencyName): Circuit {
    const circuit = this.circuits.get(dep);
    if (circuit === undefined) throw new Error(`admission-control: unknown dependency ${dep}`);
    return circuit;
  }

  private advanceCircuit(dep: DependencyName, circuit: Circuit, nowMs: number): void {
    if (circuit.state === 'open' && nowMs - circuit.openedAtMs >= this.config.circuitResetMs) {
      circuit.state = 'half_open';
      circuit.halfOpenProbes = 0;
      logger.info('capacity.admission.circuit_half_open', { dependency: dep });
    }
  }

  private isShedding(): boolean {
    return (this.shedding.get('db') ?? false) || (this.shedding.get('redis') ?? false);
  }

  private isCapacityReason(reason: AdmissionRejectionReason): boolean {
    switch (reason) {
      case 'per_user_limit':
      case 'global_limit':
      case 'provider_limit':
        return true;
      case 'queue_full':
      case 'queue_timeout':
      case 'circuit_open':
      case 'dependency_shedding':
      case 'deadline_exceeded':
      case 'rate_limited':
        return false;
    }
  }

  private reject(reason: AdmissionRejectionReason, retryAfterMs: number, message: string): RejectedDecision {
    this.rejectedTotal += 1;
    return Object.freeze({
      kind: 'rejected',
      reason,
      retryAfterMs: Math.min(Math.max(0, Math.floor(retryAfterMs)), SAFE_RETRY_AFTER_CAP_MS),
      message,
      shedBeforeExpensiveWork: true as const,
    });
  }

  private queueOrReject(
    request: AdmissionRequest,
    reason: AdmissionRejectionReason,
    retryAfterMs: number,
    message: string,
    queueable: boolean,
    nowMs: number,
  ): AdmissionDecision {
    if (!queueable || this.queue.length >= this.config.queueMax) {
      if (queueable && this.queue.length >= this.config.queueMax) {
        logger.warn('capacity.admission.queue_full', { turnId: request.turnId });
        return this.reject('queue_full', this.config.queueDeadlineMs, 'Admission queue is full; retry after the indicated delay.');
      }
      return this.reject(reason, retryAfterMs, message);
    }
    const entry: QueueEntry = {
      request,
      enqueuedAtMs: nowMs,
      deadlineMs: nowMs + this.config.queueDeadlineMs,
      seq: this.seq += 1,
    };
    this.queue.push(entry);
    this.queuedTotal += 1;
    logger.info('capacity.admission.queued', { turnId: request.turnId, position: this.queue.length });
    return Object.freeze({
      kind: 'queued',
      turnId: request.turnId,
      position: this.queue.length,
      queueDeadlineMs: this.config.queueDeadlineMs,
      retryAfterMs: Math.min(this.config.queueReserveMs, SAFE_RETRY_AFTER_CAP_MS),
    });
  }

  private acquireDistributed(scopeKey: string, request: AdmissionRequest, nowMs: number): string | null {
    if (this.distributed === undefined) return 'fast-path-only';
    let result: ReturnType<DistributedTurnLeasePort['acquire']>;
    try {
      result = this.distributed.acquire({
        scopeKey,
        turnId: request.turnId,
        ttlMs: this.config.leaseTtlMs,
        maxPerUser: this.config.maxConcurrentPerUser,
        nowMs,
      });
    } catch (error) {
      logger.warn('capacity.admission.distributed_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.failClosed ? null : 'fast-path-only';
    }
    if (!result.acquired) return null;
    return result.ownerToken ?? 'distributed';
  }

  private releaseDistributed(lease: ActiveLease): void {
    const token = lease.distributedToken;
    if (this.distributed === undefined || token === null || token === 'fast-path-only') return;
    try {
      this.distributed.release({
        scopeKey: lease.scopeKey,
        turnId: lease.turnId,
        ownerToken: token,
      });
    } catch (error) {
      logger.warn('capacity.admission.distributed_release_failed', {
        leaseId: lease.leaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private removeLease(lease: ActiveLease): void {
    this.activeByLease.delete(lease.leaseId);
    if (this.activeByTurn.get(lease.turnId) === lease.leaseId) {
      this.activeByTurn.delete(lease.turnId);
    }
    const count = this.userCounts.get(lease.scopeKey) ?? 1;
    if (count <= 1) this.userCounts.delete(lease.scopeKey);
    else this.userCounts.set(lease.scopeKey, count - 1);
    const providerCount = this.providerActive.get(lease.provider) ?? 1;
    this.providerActive.set(lease.provider, Math.max(0, providerCount - 1));
    this.releasedLog.set(lease.leaseId, lease.ownerToken);
    if (this.releasedLog.size > 1_000) {
      const oldest = this.releasedLog.keys().next();
      if (!oldest.done) this.releasedLog.delete(oldest.value);
    }
  }

  private recordOutcome(outcome: ReleaseOutcome): void {
    this.outcomeCounts.set(outcome, (this.outcomeCounts.get(outcome) ?? 0) + 1);
  }
}

export function describeDecision(decision: AdmissionDecision): string {
  switch (decision.kind) {
    case 'admitted':
      return `admitted lease=${decision.leaseId} wait=${decision.queueWaitMs}ms`;
    case 'rejected':
      return `rejected reason=${decision.reason} retryAfter=${decision.retryAfterMs}ms`;
    case 'queued':
      return `queued turn=${decision.turnId} position=${decision.position}`;
  }
}
