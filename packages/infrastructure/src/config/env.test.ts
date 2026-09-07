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

  it('parses and validates WP-2 retrieval controls', () => {
    expect(loadEnvConfig(env({
      RERANKER_THRESHOLD: '0.65',
      LEXICAL_SEARCH_MODE: 'content_plain',
    }))).toMatchObject({
      RERANKER_THRESHOLD: 0.65,
      LEXICAL_SEARCH_MODE: 'content_plain',
    });
    expect(loadEnvConfig(env({ RERANKER_THRESHOLD: '1.1' })).RERANKER_THRESHOLD).toBe(0.5);
    expect(loadEnvConfig(env({ LEXICAL_SEARCH_MODE: 'unknown' })).LEXICAL_SEARCH_MODE)
      .toBe('weighted_websearch');
  });
});
