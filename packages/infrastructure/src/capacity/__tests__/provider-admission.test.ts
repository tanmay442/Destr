import { describe, expect, it, afterEach } from 'vitest';
import {
  ProviderAdmission,
  resolveProviderAdmissionConfig,
} from '../provider-admission';

const admissions: ProviderAdmission[] = [];
afterEach(() => {
  while (admissions.length > 0) admissions.pop()?.destroy();
});

function makeAdmission(overrides: Record<string, unknown> = {}): {
  admission: ProviderAdmission;
  now: { current: number };
} {
  const now = { current: 4_000_000 };
  const admission = new ProviderAdmission({
    config: resolveProviderAdmissionConfig({
      globalMax: 8,
      perProviderMax: { main: 4, planner: 4, grader: 2, embedding: 4, reranker: 4 },
      interactiveReserve: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 10_000,
      ...overrides,
    }),
    now: () => now.current,
  });
  admissions.push(admission);
  return { admission, now };
}

describe('provider-admission concurrency ceilings', () => {
  it('rejects saturated providers with typed Retry-After before model work', () => {
    const { admission } = makeAdmission();
    for (let i = 0; i < 4; i += 1) {
      const decision = admission.tryAcquire({ provider: 'main', kind: 'interactive' });
      expect(decision.kind).toBe('admitted');
    }
    const saturated = admission.tryAcquire({ provider: 'main', kind: 'interactive' });
    expect(saturated.kind).toBe('rejected');
    if (saturated.kind !== 'rejected') throw new Error('expected saturation rejection');
    expect(saturated.category).toBe('provider_saturated');
    expect(saturated.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(saturated.shedBeforeWork).toBe(true);
    admission.release('main');
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
  });

  it('rejects global saturation independently of provider headroom', () => {
    const { admission } = makeAdmission({ globalMax: 2 });
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
    expect(admission.tryAcquire({ provider: 'embedding', kind: 'interactive' }).kind).toBe('admitted');
    const saturated = admission.tryAcquire({ provider: 'reranker', kind: 'interactive' });
    expect(saturated.kind).toBe('rejected');
    if (saturated.kind !== 'rejected') throw new Error('expected global rejection');
    expect(saturated.category).toBe('global_saturated');
  });

  it('preserves the interactive reservation: background sheds first', () => {
    const { admission } = makeAdmission();
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
    const judge = admission.tryAcquire({ provider: 'main', kind: 'background' });
    expect(judge.kind).toBe('rejected');
    if (judge.kind !== 'rejected') throw new Error('expected reserve rejection');
    expect(judge.category).toBe('interactive_reserve');
    expect(judge.shedBeforeWork).toBe(true);
    admission.release('main');
    admission.release('main');
    expect(admission.tryAcquire({ provider: 'main', kind: 'background' }).kind).toBe('admitted');
  });

  it('judge backlog cannot consume the interactive reservation', () => {
    const { admission } = makeAdmission();
    let backgroundAdmitted = 0;
    for (let i = 0; i < 10; i += 1) {
      const decision = admission.tryAcquire({ provider: 'grader', kind: 'background' });
      if (decision.kind === 'admitted') backgroundAdmitted += 1;
      else if (decision.kind === 'rejected') expect(decision.category).toBe('interactive_reserve');
      else throw new Error('unexpected decision shape');
    }
    expect(backgroundAdmitted).toBeLessThanOrEqual(0);
    expect(admission.tryAcquire({ provider: 'grader', kind: 'interactive' }).kind).toBe('admitted');
    expect(admission.tryAcquire({ provider: 'grader', kind: 'interactive' }).kind).toBe('admitted');
  });

  it('enforces the per-minute rate with a typed rate_limited rejection', () => {
    const { admission } = makeAdmission({
      perProviderRatePerMinute: { main: 2, planner: 100, grader: 100, embedding: 100, reranker: 100 },
      globalMax: 64,
    });
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
    admission.release('main');
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
    admission.release('main');
    const limited = admission.tryAcquire({ provider: 'main', kind: 'interactive' });
    expect(limited.kind).toBe('rejected');
    if (limited.kind !== 'rejected') throw new Error('expected rate rejection');
    expect(limited.category).toBe('rate_limited');
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('provider-admission circuits and dependency shedding', () => {
  it('opens on provider 429/5xx storms and recovers through half-open', () => {
    const { admission, now } = makeAdmission();
    admission.recordFailure('main', 'throttle_429');
    admission.recordFailure('main', 'server_5xx');
    admission.recordFailure('main', 'throttle_429');
    expect(admission.circuitState('main')).toBe('open');
    const shed = admission.tryAcquire({ provider: 'main', kind: 'interactive' });
    expect(shed.kind).toBe('rejected');
    if (shed.kind !== 'rejected') throw new Error('expected circuit rejection');
    expect(shed.category).toBe('circuit_open');
    expect(shed.retryAfterMs).toBeGreaterThan(0);
    now.current += 11_000;
    expect(admission.circuitState('main')).toBe('half_open');
    admission.recordSuccess('main');
    expect(admission.circuitState('main')).toBe('closed');
    expect(admission.tryAcquire({ provider: 'main', kind: 'interactive' }).kind).toBe('admitted');
  });

  it('sheds background provider work on db/redis degradation, never interactive capacity', () => {
    const { admission } = makeAdmission();
    admission.reportRedisError();
    admission.reportPoolWait(5_000);
    const background = admission.tryAcquire({ provider: 'embedding', kind: 'background' });
    expect(background.kind).toBe('rejected');
    if (background.kind !== 'rejected') throw new Error('expected dependency shed');
    expect(background.category).toBe('dependency_shedding');
    expect(admission.tryAcquire({ provider: 'embedding', kind: 'interactive' }).kind).toBe('admitted');
    admission.recordDependencySuccess('db');
    admission.recordDependencySuccess('redis');
    admission.release('embedding');
    expect(admission.tryAcquire({ provider: 'embedding', kind: 'background' }).kind).toBe('admitted');
  });

  it('network blips alone do not trip the breaker', () => {
    const { admission } = makeAdmission();
    admission.recordFailure('main', 'network');
    admission.recordFailure('main', 'network');
    expect(admission.circuitState('main')).toBe('closed');
  });
});
