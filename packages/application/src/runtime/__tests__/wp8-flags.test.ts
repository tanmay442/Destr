import { describe, expect, it } from 'vitest';
import {
  WP8_FLAGS,
  WP8_FLAG_NAMES,
  WP8_ROLLBACK_PRESERVED_INVARIANTS,
  readWp8Flag,
  readWp8Flags,
  type Wp8FlagEnv,
} from '../wp8-flags';

function env(values: Record<string, string>): Wp8FlagEnv {
  return {
    get: (key: string) => values[key],
  };
}

const EMPTY: Wp8FlagEnv = { get: () => undefined };

describe('wp8 flags parse independently', () => {
  it('accepts 1/true/on/yes as enabled', () => {
    for (const raw of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', 'YES']) {
      const flags = readWp8Flags(env({ WP8_SERVER_PROGRESS_ENABLED: raw }));
      expect(flags.serverProgress).toEqual({ enabled: true, source: 'env' });
      expect(flags.distributedAdmission.enabled).toBe(false);
    }
  });

  it('accepts 0/false/off/no as disabled', () => {
    for (const raw of ['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'NO']) {
      const flags = readWp8Flags(
        env({
          WP8_SERVER_PROGRESS_ENABLED: '1',
          WP8_DISTRIBUTED_ADMISSION_ENABLED: raw,
        }),
      );
      expect(flags.distributedAdmission).toEqual({ enabled: false, source: 'env' });
      expect(flags.serverProgress.enabled).toBe(true);
    }
  });

  it('defaults every flag to safe-off with a default source', () => {
    const flags = readWp8Flags(EMPTY);
    for (const name of WP8_FLAG_NAMES) {
      expect(flags[name]).toEqual({ enabled: false, source: 'default' });
      expect(WP8_FLAGS[name]?.defaultEnabled).toBe(false);
    }
  });

  it('fails safe to the default on unrecognized values', () => {
    for (const raw of ['maybe', '2', '', 'enabled-ish']) {
      expect(readWp8Flag(env({ WP8_ROUTE_DURATION_INCREASE_ENABLED: raw }), 'routeDurationIncrease')).toEqual(
        { enabled: false, source: 'env' },
      );
    }
  });

  it('reads all five flags in one frozen snapshot', () => {
    const flags = readWp8Flags(
      env({
        WP8_SERVER_PROGRESS_ENABLED: '1',
        WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED: 'yes',
        WP8_DISTRIBUTED_ADMISSION_ENABLED: '0',
        WP8_DURABLE_JUDGE_QUEUE_ENABLED: 'off',
        WP8_ROUTE_DURATION_INCREASE_ENABLED: 'no',
      }),
    );
    expect(flags.serverProgress.enabled).toBe(true);
    expect(flags.embeddingRetrievalCache.enabled).toBe(true);
    expect(flags.distributedAdmission.enabled).toBe(false);
    expect(flags.durableJudgeQueue.enabled).toBe(false);
    expect(flags.routeDurationIncrease.enabled).toBe(false);
    expect(Object.isFrozen(flags)).toBe(true);
  });
});

describe('wp8 flags have no global switch', () => {
  it('exposes exactly the five independent flags', () => {
    expect(WP8_FLAG_NAMES).toHaveLength(5);
    expect(Object.keys(WP8_FLAGS)).toHaveLength(5);
    for (const name of WP8_FLAG_NAMES) {
      const flag = WP8_FLAGS[name];
      expect(flag).toBeDefined();
      expect(flag?.key.startsWith('WP8_')).toBe(true);
      expect(flag?.key).not.toMatch(/ALL|GLOBAL/);
    }
  });

  it('ignores global-sounding environment variables', () => {
    const flags = readWp8Flags(
      env({ WP8_ALL_ENABLED: '1', WP8_GLOBAL_ENABLED: 'true', WP8_ENABLED: '1' }),
    );
    for (const name of WP8_FLAG_NAMES) {
      expect(flags[name]).toEqual({ enabled: false, source: 'default' });
    }
  });

  it('keeps each flag key unique', () => {
    const keys = WP8_FLAG_NAMES.map((name) => (WP8_FLAGS[name] as { key: string }).key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('wp8 flag metadata and rollback', () => {
  it('documents owner, default, effect, rollout, removal, rollback, and metrics per flag', () => {
    for (const name of WP8_FLAG_NAMES) {
      const flag = WP8_FLAGS[name];
      expect(flag).toBeDefined();
      if (flag === undefined) throw new Error(`missing flag ${name}`);
      expect(flag.owner.length).toBeGreaterThan(0);
      expect(flag.defaultEnabled).toBe(false);
      expect(flag.effect.length).toBeGreaterThan(0);
      expect(flag.rollout.length).toBeGreaterThan(0);
      expect(flag.removal.length).toBeGreaterThan(0);
      expect(flag.rollback.length).toBeGreaterThan(0);
      expect(flag.metrics.length).toBeGreaterThan(0);
      expect(flag.rollbackThresholds.length).toBeGreaterThan(0);
      expect(Object.isFrozen(flag)).toBe(true);
    }
  });

  it('preserves grounding, approval, idempotency, error, provenance, budget, and overload invariants on every rollback', () => {
    expect(WP8_ROLLBACK_PRESERVED_INVARIANTS).toEqual([
      'grounding_policy',
      'approval_policy',
      'idempotency',
      'error_classification',
      'score_provenance',
      'budgets',
      'overload_safety',
    ]);
    for (const name of WP8_FLAG_NAMES) {
      const flag = WP8_FLAGS[name];
      if (flag === undefined) throw new Error(`missing flag ${name}`);
      expect([...flag.rollbackPreserves].sort()).toEqual(
        [...WP8_ROLLBACK_PRESERVED_INVARIANTS].sort(),
      );
    }
  });

  it('keeps route-duration rollback independent of agent budgets', () => {
    const flag = WP8_FLAGS.routeDurationIncrease;
    if (flag === undefined) throw new Error('missing routeDurationIncrease flag');
    expect(flag.effect).toMatch(/never increases/);
    expect(flag.rollback).toMatch(/rejected at startup/);
  });
});
