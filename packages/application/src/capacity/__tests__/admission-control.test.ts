import { describe, expect, it, afterEach } from 'vitest';
import {
  AdmissionController,
  resolveAdmissionConfig,
  type AdmissionRequest,
  type DistributedTurnLeasePort,
} from '../admission-control';

interface FakeLease {
  token: string;
  expiresAtMs: number;
}

/** Shared across simulated instances to emulate a distributed store. */
function createSharedPort(options: { ttlMs?: number } = {}): DistributedTurnLeasePort & { clear(): void } {
  const ttlMs = options.ttlMs ?? 120_000;
  const held = new Map<string, Map<string, FakeLease>>();
  return {
    isDistributed: true,
    acquire(input): { acquired: boolean; ownerToken?: string | undefined; retryAfterMs?: number | undefined } {
      let scope = held.get(input.scopeKey);
      if (scope === undefined) {
        scope = new Map();
        held.set(input.scopeKey, scope);
      }
      for (const [turnId, lease] of [...scope]) {
        if (lease.expiresAtMs <= input.nowMs) scope.delete(turnId);
      }
      if (scope.size >= input.maxPerUser) return { acquired: false, retryAfterMs: 1_000 };
      if (scope.has(input.turnId)) return { acquired: false, retryAfterMs: 1_000 };
      const ownerToken = `dist-${input.scopeKey.length}-${scope.size}-${input.nowMs}`;
      scope.set(input.turnId, { token: ownerToken, expiresAtMs: input.nowMs + (input.ttlMs || ttlMs) });
      return { acquired: true, ownerToken };
    },
    release(input): boolean {
      const scope = held.get(input.scopeKey);
      const lease = scope?.get(input.turnId);
      if (lease === undefined) return false;
      if (lease.token !== input.ownerToken) return false;
      scope?.delete(input.turnId);
      return true;
    },
    clear(): void {
      held.clear();
    },
  };
}

const controllers: AdmissionController[] = [];
afterEach(() => {
  while (controllers.length > 0) {
    const controller = controllers.pop();
    controller?.destroy();
  }
});

function makeController(overrides: Record<string, unknown> = {}, port?: DistributedTurnLeasePort): {
  controller: AdmissionController;
  now: { current: number };
} {
  const now = { current: 1_000_000 };
  let ids = 0;
  const controller = new AdmissionController({
    config: resolveAdmissionConfig({ queueMax: 8, ...overrides }),
    now: () => now.current,
    newId: () => `id-${(ids += 1)}`,
    ...(port !== undefined ? { distributed: port } : {}),
  });
  controllers.push(controller);
  return { controller, now };
}

let turnSeq = 0;
function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  turnSeq += 1;
  return {
    userId: 'user-1',
    turnId: `turn-${turnSeq}`,
    provider: 'main',
    kind: 'interactive',
    ...overrides,
  };
}

describe('admission-control per-user leases', () => {
  it('admits up to the per-user limit then rejects with typed Retry-After', () => {
    const { controller } = makeController({ maxConcurrentPerUser: 2 });
    const first = controller.tryAdmit(request({ turnId: 't-1' }));
    const second = controller.tryAdmit(request({ turnId: 't-2' }));
    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    const third = controller.tryAdmit(request({ turnId: 't-3', queueable: false }));
    expect(third.kind).toBe('rejected');
    if (third.kind !== 'rejected') throw new Error('expected rejection');
    expect(third.reason).toBe('per_user_limit');
    expect(third.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(third.shedBeforeExpensiveWork).toBe(true);
  });

  it('re-admitting the same turnId is idempotent and does not double-count', () => {
    const { controller } = makeController({ maxConcurrentPerUser: 1 });
    const first = controller.tryAdmit(request({ turnId: 't-same' }));
    expect(first.kind).toBe('admitted');
    const again = controller.tryAdmit(request({ turnId: 't-same' }));
    expect(again).toEqual(first);
    expect(controller.stats().active).toBe(1);
  });

  it('enforces the distributed per-user lease across simulated instances', () => {
    const port = createSharedPort();
    try {
      const a = makeController({ maxConcurrentPerUser: 2 }, port);
      const b = makeController({ maxConcurrentPerUser: 2 }, port);
      expect(a.controller.tryAdmit(request({ turnId: 'a-1' })).kind).toBe('admitted');
      expect(a.controller.tryAdmit(request({ turnId: 'a-2' })).kind).toBe('admitted');
      const cross = b.controller.tryAdmit(request({ turnId: 'b-1', queueable: false }));
      expect(cross.kind).toBe('rejected');
      if (cross.kind !== 'rejected') throw new Error('expected cross-instance rejection');
      expect(cross.reason).toBe('per_user_limit');
      expect(b.controller.stats().active).toBe(0);
    } finally {
      port.clear();
    }
  });

  it('recovers expired leases on both the fast path and the distributed port', () => {
    const port = createSharedPort({ ttlMs: 5_000 });
    try {
      const { controller, now } = makeController({ maxConcurrentPerUser: 1, leaseTtlMs: 1_000 }, port);
      const first = controller.tryAdmit(request({ turnId: 'exp-1' }));
      expect(first.kind).toBe('admitted');
      now.current += 10_000;
      const recovered = controller.purgeExpired();
      expect(recovered).toBe(1);
      const second = controller.tryAdmit(request({ turnId: 'exp-2', queueable: false }));
      expect(second.kind).toBe('admitted');
      expect(controller.stats().outcomes.expired).toBe(1);
    } finally {
      port.clear();
    }
  });

  it('fails closed when the distributed store throws', () => {
    const broken: DistributedTurnLeasePort = {
      isDistributed: true,
      acquire(): never {
        throw new Error('redis down');
      },
      release(): boolean {
        return false;
      },
    };
    const { controller } = makeController({}, broken);
    const decision = controller.tryAdmit(request({ turnId: 'closed-1', queueable: false }));
    expect(decision.kind).toBe('rejected');
  });
});

describe('admission-control exactly-once release', () => {
  it.each(['completed', 'cancelled', 'disconnected', 'timeout', 'error'] as const)(
    'releases exactly once on %s',
    (outcome) => {
      const { controller } = makeController();
      const admitted = controller.tryAdmit(request({ turnId: `once-${outcome}` }));
      if (admitted.kind !== 'admitted') throw new Error('expected admission');
      const first = controller.release({ leaseId: admitted.leaseId, ownerToken: admitted.ownerToken, outcome });
      expect(first).toEqual({ kind: 'released', outcome });
      const second = controller.release({ leaseId: admitted.leaseId, ownerToken: admitted.ownerToken, outcome });
      expect(second.kind).toBe('already_released');
      expect(controller.stats().active).toBe(0);
    },
  );

  it('rejects a wrong ownership token without freeing the permit', () => {
    const { controller } = makeController();
    const admitted = controller.tryAdmit(request({ turnId: 'token-1' }));
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    const mismatch = controller.release({ leaseId: admitted.leaseId, ownerToken: 'wrong-token', outcome: 'completed' });
    expect(mismatch.kind).toBe('token_mismatch');
    expect(controller.stats().active).toBe(1);
  });

  it('frees permits by turnId on disconnect without leaking', () => {
    const { controller } = makeController();
    const admitted = controller.tryAdmit(request({ turnId: 'disc-1' }));
    expect(admitted.kind).toBe('admitted');
    expect(controller.releaseByTurn({ turnId: 'disc-1', outcome: 'disconnected' })).toBe(true);
    expect(controller.stats().active).toBe(0);
    expect(controller.releaseByTurn({ turnId: 'disc-1', outcome: 'disconnected' })).toBe(false);
    expect(controller.stats().outcomes.disconnected).toBe(1);
  });
});

describe('admission-control bounded queue', () => {
  it('queues within bounds and rejects queue-full with Retry-After', () => {
    const { controller } = makeController({ maxConcurrentPerUser: 1, queueMax: 1, queueDeadlineMs: 5_000 });
    expect(controller.tryAdmit(request({ turnId: 'q-1' })).kind).toBe('admitted');
    const queued = controller.tryAdmit(request({ turnId: 'q-2' }));
    expect(queued.kind).toBe('queued');
    if (queued.kind !== 'queued') throw new Error('expected queued');
    expect(queued.position).toBe(1);
    const full = controller.tryAdmit(request({ turnId: 'q-3' }));
    expect(full.kind).toBe('rejected');
    if (full.kind !== 'rejected') throw new Error('expected queue-full rejection');
    expect(full.reason).toBe('queue_full');
    expect(full.retryAfterMs).toBe(5_000);
    expect(full.shedBeforeExpensiveWork).toBe(true);
  });

  it('expires queued turns at the queue deadline with a typed rejection', () => {
    const { controller, now } = makeController({ maxConcurrentPerUser: 1, queueMax: 4, queueDeadlineMs: 1_000 });
    expect(controller.tryAdmit(request({ turnId: 'd-1' })).kind).toBe('admitted');
    expect(controller.tryAdmit(request({ turnId: 'd-2' })).kind).toBe('queued');
    now.current += 2_000;
    const pumped = controller.pumpQueue();
    expect(pumped.admitted).toHaveLength(0);
    expect(pumped.expired).toHaveLength(1);
    expect(pumped.expired[0]?.reason).toBe('queue_timeout');
  });

  it('prioritizes interactive queued turns over background ones', () => {
    const { controller } = makeController({ maxConcurrentPerUser: 1, queueMax: 8, globalMaxConcurrent: 1 });
    const first = controller.tryAdmit(request({ turnId: 'p-1', provider: 'main' }));
    expect(first.kind).toBe('admitted');
    expect(controller.tryAdmit(request({ turnId: 'p-bg', provider: 'main', kind: 'background' })).kind).toBe('queued');
    expect(controller.tryAdmit(request({ turnId: 'p-int', provider: 'main', kind: 'interactive' })).kind).toBe('queued');
    if (first.kind !== 'admitted') throw new Error('expected admission');
    // release() pumps the queue internally, so the promotion already happened.
    expect(controller.release({ leaseId: first.leaseId, ownerToken: first.ownerToken, outcome: 'completed' }).kind).toBe('released');
    expect(controller.stats().active).toBe(1);
    expect(controller.stats().queueDepth).toBe(1);
    // Interactive priority: the interactive turn was promoted, background still waits.
    // Check the queued turn first: releasing it must fail (no pump runs on failure).
    expect(controller.releaseByTurn({ turnId: 'p-bg', outcome: 'completed' })).toBe(false);
    expect(controller.releaseByTurn({ turnId: 'p-int', outcome: 'completed' })).toBe(true);
    // Releasing the interactive turn pumps the remaining background turn.
    expect(controller.stats().active).toBe(1);
    expect(controller.releaseByTurn({ turnId: 'p-bg', outcome: 'completed' })).toBe(true);
    expect(controller.stats().active).toBe(0);
  });
});

describe('admission-control circuits and shedding', () => {
  it('opens the provider circuit after the failure threshold with typed Retry-After', () => {
    const { controller, now } = makeController({ circuitFailureThreshold: 3, circuitResetMs: 30_000 });
    controller.recordDependencyFailure('provider', 'throttle');
    controller.recordDependencyFailure('provider', 'throttle');
    controller.recordDependencyFailure('provider', 'throttle');
    expect(controller.circuitState('provider')).toBe('open');
    const rejected = controller.tryAdmit(request({ turnId: 'c-1', queueable: false }));
    expect(rejected.kind).toBe('rejected');
    if (rejected.kind !== 'rejected') throw new Error('expected circuit rejection');
    expect(rejected.reason).toBe('circuit_open');
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    const shed = controller.shedBeforeExpensiveWork({ provider: 'main', kind: 'interactive' });
    expect(shed?.reason).toBe('circuit_open');
    now.current += 31_000;
    expect(controller.circuitState('provider')).toBe('half_open');
    controller.recordDependencySuccess('provider');
    expect(controller.circuitState('provider')).toBe('closed');
    expect(controller.tryAdmit(request({ turnId: 'c-2' })).kind).toBe('admitted');
  });

  it('sheds background work on db/redis degradation while preserving interactive traffic', () => {
    const { controller } = makeController({ maxConcurrentPerUser: 8, globalMaxConcurrent: 8 });
    controller.recordDependencyFailure('db', 'timeout');
    controller.recordDependencyFailure('redis', 'error');
    const background = controller.tryAdmit(request({ turnId: 's-bg', kind: 'background', queueable: false }));
    expect(background.kind).toBe('rejected');
    if (background.kind !== 'rejected') throw new Error('expected background shed');
    expect(background.reason).toBe('dependency_shedding');
    expect(controller.tryAdmit(request({ turnId: 's-int', kind: 'interactive' })).kind).toBe('admitted');
    expect(controller.shedBeforeExpensiveWork({ provider: 'embedding', kind: 'background' })?.reason)
      .toBe('dependency_shedding');
    expect(controller.shedBeforeExpensiveWork({ provider: 'embedding', kind: 'interactive' })).toBeNull();
  });

  it('sheds before expensive work when the provider is saturated', () => {
    const { controller } = makeController({
      maxConcurrentPerUser: 8,
      globalMaxConcurrent: 64,
      providerMax: { main: 1, planner: 64, grader: 64, embedding: 64, reranker: 64 },
    });
    expect(controller.tryAdmit(request({ userId: 'u-a', turnId: 'sat-1', provider: 'main' })).kind).toBe('admitted');
    const saturated = controller.tryAdmit(request({ userId: 'u-b', turnId: 'sat-2', provider: 'main', queueable: false }));
    expect(saturated.kind).toBe('rejected');
    if (saturated.kind !== 'rejected') throw new Error('expected provider saturation rejection');
    expect(saturated.reason).toBe('provider_limit');
    expect(saturated.shedBeforeExpensiveWork).toBe(true);
    expect(controller.shedBeforeExpensiveWork({ provider: 'main', kind: 'interactive' })?.reason)
      .toBe('provider_limit');
  });

  it('rejects expired deadlines without starting work', () => {
    const { controller, now } = makeController();
    const rejected = controller.tryAdmit(request({ turnId: 'dl-1', deadlineAtMs: now.current - 1 }));
    expect(rejected.kind).toBe('rejected');
    if (rejected.kind !== 'rejected') throw new Error('expected deadline rejection');
    expect(rejected.reason).toBe('deadline_exceeded');
    expect(rejected.retryAfterMs).toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    expect(controller.shedBeforeExpensiveWork({ provider: 'main', kind: 'interactive', signal: aborted.signal })?.reason)
      .toBe('deadline_exceeded');
  });
});
