import { describe, expect, it } from 'vitest';
import type { EnvSource } from '@app/domain';
import { loadEnvConfig, resetEnvConfigForTests } from './env';

function env(values: Record<string, string | undefined>): EnvSource {
  return { get: (key) => values[key] };
}

describe('loadEnvConfig', () => {
  it('resolves explicit env sources freshly', () => {
    expect(loadEnvConfig(env({ LOG_LEVEL: 'debug' })).LOG_LEVEL).toBe('debug');
    expect(loadEnvConfig(env({}))).toMatchObject({ LOG_LEVEL: 'info' });
  });

  it('memoizes the default process env until reset', () => {
    const first = loadEnvConfig();
    expect(loadEnvConfig()).toBe(first);
    resetEnvConfigForTests();
    expect(loadEnvConfig()).not.toBe(first);
  });
});
