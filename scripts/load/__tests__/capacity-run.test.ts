import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@app/domain';
import {
  ALL_FAULTS,
  FROZEN_MIX,
  SCENARIO_MODEL,
  mulberry32,
  parseCapacityArgs,
  percentileOf,
  runCapacitySuite,
  CapacityUsageError,
  type CapacitySuiteOptions,
} from '../capacity-run';
import {
  authorizeLoad,
  allowedTargets,
  executeLoad,
  isProductionLike,
  parseLoadAgentArgs,
  LoadAgentUsageError,
} from '../load-agent';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function suiteOptions(overrides: Partial<CapacitySuiteOptions> = {}): CapacitySuiteOptions {
  return {
    profile: 'synthetic',
    stages: [20, 40],
    faults: ['provider-429', 'cancel-storm', 'queue-exhaustion', 'judge-backlog'],
    seed: 7,
    turnsPerClient: 1,
    costCeilingMicros: 50_000_000,
    allow20k: false,
    ...overrides,
  };
}

describe('capacity-run argument parsing', () => {
  it('requires the synthetic profile', () => {
    expect(() => parseCapacityArgs([])).toThrow(CapacityUsageError);
    expect(() => parseCapacityArgs(['--profile', 'average-4k'])).toThrow(/synthetic/);
    expect(parseCapacityArgs(['--profile', 'synthetic']).profile).toBe('synthetic');
  });

  it('validates stages and reserves 20k for separate authorization', () => {
    expect(parseCapacityArgs(['--profile', 'synthetic', '--stages', '10,20']).stages).toEqual([10, 20]);
    expect(() => parseCapacityArgs(['--profile', 'synthetic', '--stages', 'nope'])).toThrow(CapacityUsageError);
    expect(() => parseCapacityArgs(['--profile', 'synthetic', '--stages', '100,20000'])).toThrow(/allow-20k/);
    expect(parseCapacityArgs(['--profile', 'synthetic', '--stages', '20000', '--allow-20k']).stages).toEqual([20_000]);
  });

  it('validates faults and seed', () => {
    expect(parseCapacityArgs(['--profile', 'synthetic', '--faults', 'none']).faults).toEqual([]);
    expect(parseCapacityArgs(['--profile', 'synthetic', '--faults', 'all']).faults).toEqual([...ALL_FAULTS]);
    expect(() => parseCapacityArgs(['--profile', 'synthetic', '--faults', 'meteor'])).toThrow(/unknown fault/);
    expect(() => parseCapacityArgs(['--profile', 'synthetic', '--seed', '-1'])).toThrow(CapacityUsageError);
  });

  it('keeps the frozen mix total at 100 across the documented scenarios', () => {
    const total = FROZEN_MIX.cache_hit + FROZEN_MIX.no_tool + FROZEN_MIX.one_search + FROZEN_MIX.two_search;
    expect(total).toBe(100);
    for (const scenario of Object.keys(FROZEN_MIX)) {
      expect(SCENARIO_MODEL[scenario as keyof typeof SCENARIO_MODEL].durationMs).toBeGreaterThan(0);
    }
  });

  it('uses deterministic seeded randomness and percentiles', () => {
    const first = mulberry32(11);
    const second = mulberry32(11);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(percentileOf([], 0.95)).toBeNull();
    expect(percentileOf([1, 2, 3, 4], 0.5)).toBe(3);
  });
});

describe('capacity-run synthetic gate', () => {
  beforeEach(() => {
    configureLogger('error');
  });
  afterEach(() => {
    configureLogger('info');
  });
  it('passes every assertion on a small deterministic suite', () => {
    // The full 100/500/1000/4000 profile is gated by `pnpm test:capacity`.
    // Per-turn structured logs are silenced in-suite (errors still surface);
    // assertions are unchanged.
    const report = runCapacitySuite(suiteOptions());
    expect(report.status).toBe('pass');
    expect(report.assertions.length).toBeGreaterThan(8);
    for (const assertion of report.assertions) {
      expect(assertion.passed, `${assertion.id}: ${assertion.detail}`).toBe(true);
    }
    expect(report.totals.ambiguous).toBe(0);
  }, 30_000);

  it('is deterministic for a fixed seed', () => {
    // Scale-invariant engine proof on a small config: the seeded pipeline
    // (admission, faults, assertions) is byte-identical across runs. Scale
    // itself is proven by the gate test above and `pnpm test:capacity`.
    const small = suiteOptions({ stages: [8], faults: ['provider-429'], seed: 7 });
    const first = runCapacitySuite(small);
    const second = runCapacitySuite(small);
    expect(second.status).toBe('pass');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 30_000);

  it('detects bounded shedding under overload with 100% typed terminals', () => {
    const report = runCapacitySuite(suiteOptions({
      stages: [400],
      faults: ['queue-exhaustion'],
      seed: 99,
    }));
    const probe = report.stages.find((stage) => stage.stage === 'fault:queue-exhaustion');
    expect(probe).toBeDefined();
    expect(probe?.terminals['rejected_queue_full'] ?? 0).toBeGreaterThan(0);
    const assertion = report.assertions.find((entry) => entry.id === 'fault.queue_exhaustion_sheds_typed');
    expect(assertion?.passed).toBe(true);
  }, 30_000);

  it('recovers within the synthetic budget and isolates judges', () => {
    const report = runCapacitySuite(suiteOptions({ faults: ['provider-429', 'judge-backlog'], seed: 13 }));
    expect(report.assertions.find((entry) => entry.id === 'fault.recovery_within_5min')?.passed).toBe(true);
    const isolation = report.assertions.find((entry) => entry.id === 'isolation.judge_backlog');
    expect(isolation?.passed, isolation?.detail).toBe(true);
  }, 30_000);

  it('accounts cost and cache behavior honestly', () => {
    const report = runCapacitySuite(suiteOptions({ stages: [30], faults: [], seed: 5 }));
    expect(report.totals.costMicros).toBeGreaterThan(0);
    expect(report.assertions.find((entry) => entry.id === 'cache.use')?.passed).toBe(true);
    expect(report.assertions.find((entry) => entry.id === 'cost.ceiling')?.passed).toBe(true);
  }, 30_000);
});

describe('load-agent safety gates', () => {
  const baseArgs = [
    '--profile=average-4k',
    '--target=https://loadtest.example.internal',
    '--identity=loadtest-smoke-a',
    '--duration-s=600',
    '--cost-ceiling-usd=50',
    '--report=/tmp/opencode/load-agent-report.json',
  ];

  function allowEnv(): Record<string, string> {
    return { LOAD_AGENT_ALLOWED_TARGETS: 'https://loadtest.example.internal' };
  }

  it('requires every safety flag', () => {
    expect(() => parseLoadAgentArgs([])).toThrow(LoadAgentUsageError);
    expect(() => parseLoadAgentArgs(baseArgs.slice(1))).toThrow(/profile/);
    expect(() => parseLoadAgentArgs(baseArgs.filter((arg) => !arg.startsWith('--target')))).toThrow(/target/);
    expect(() => parseLoadAgentArgs(baseArgs.filter((arg) => !arg.startsWith('--cost-ceiling')))).toThrow(/cost-ceiling/);
  });

  it('bounds duration and cost ceiling', () => {
    expect(() => parseLoadAgentArgs(baseArgs.map((arg) => arg === '--duration-s=600' ? '--duration-s=99999' : arg)))
      .toThrow(/bounded/);
    expect(() => parseLoadAgentArgs(baseArgs.map((arg) => arg === '--cost-ceiling-usd=50' ? '--cost-ceiling-usd=0' : arg)))
      .toThrow(/positive/);
  });

  it('refuses production targets even when allowlisted', () => {
    const parsed = parseLoadAgentArgs(baseArgs.map((arg) =>
      arg.startsWith('--target') ? '--target=https://api.prod.example.com' : arg));
    const decision = authorizeLoad(parsed, {
      LOAD_AGENT_ALLOWED_TARGETS: 'https://api.prod.example.com',
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('production must be refused');
    expect(decision.reasons.join(' ')).toMatch(/production/i);
    expect(isProductionLike('https://api.prod.example.com')).toBe(true);
    // Regression: the scheme's "//" precedes a bare prod hostname, so the
    // match must run against the hostname, not the raw target string.
    expect(isProductionLike('https://prod.example.com')).toBe(true);
    expect(isProductionLike('https://production.example.com')).toBe(true);
    expect(isProductionLike('https://loadtest.example.internal')).toBe(false);
  });

  it('refuses a bare prod hostname even when allowlisted', () => {
    const parsed = parseLoadAgentArgs(baseArgs.map((arg) =>
      arg.startsWith('--target') ? '--target=https://prod.example.com' : arg));
    const decision = authorizeLoad(parsed, {
      LOAD_AGENT_ALLOWED_TARGETS: 'https://prod.example.com',
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('bare prod hostname must be refused');
    expect(decision.reasons.join(' ')).toMatch(/production/i);
  });

  it('refuses unknown targets by default', () => {
    const parsed = parseLoadAgentArgs(baseArgs);
    const decision = authorizeLoad(parsed, { LOAD_AGENT_ALLOWED_TARGETS: 'https://other.example.internal' });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unknown target must be refused');
    expect(allowedTargets({})).toEqual([]);
  });

  it('requires isolated loadtest identities', () => {
    const parsed = parseLoadAgentArgs(baseArgs.map((arg) =>
      arg.startsWith('--identity') ? '--identity=real-user-1' : arg));
    const decision = authorizeLoad(parsed, allowEnv());
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('non-isolated identity must be refused');
  });

  it('requires separate peak authorization plus matching cost confirmation', () => {
    const peakArgs = baseArgs.map((arg) => arg === '--profile=average-4k' ? '--profile=peak-20k' : arg);
    const parsed = parseLoadAgentArgs(peakArgs);
    expect(authorizeLoad(parsed, allowEnv()).allowed).toBe(false);
    const withApproval = authorizeLoad(parsed, { ...allowEnv(), LOAD_AGENT_PEAK_APPROVAL: '1' });
    expect(withApproval.allowed).toBe(false);
    const confirmed = parseLoadAgentArgs([...peakArgs, '--confirm-cost-cap=50']);
    const decision = authorizeLoad(confirmed, { ...allowEnv(), LOAD_AGENT_PEAK_APPROVAL: '1' });
    expect(decision.allowed).toBe(true);
  });

  it('authorizes a compliant dry run without sending traffic', () => {
    const parsed = parseLoadAgentArgs(baseArgs);
    expect(parsed.execute).toBe(false);
    const decision = authorizeLoad(parsed, allowEnv());
    expect(decision.allowed).toBe(true);
  });

  it('executes bounded traffic against a local harness and classifies terminals', async () => {
    const server = createServer((req, res) => {
      void req;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound port');
    const metrics = await executeLoad({
      profile: 'average-4k',
      activeTurns: 4_000,
      target: `http://127.0.0.1:${address.port}`,
      identity: 'loadtest-harness',
      durationS: 1,
      costCeilingUsd: 1,
      method: 'GET',
      path: '/api/health',
      maxConnections: 2,
      abortShedRate: 0.5,
    });
    expect(metrics.requests).toBeGreaterThan(0);
    expect(metrics.ok).toBe(metrics.requests);
    expect(metrics.resets).toBe(0);
  }, 15_000);
});
