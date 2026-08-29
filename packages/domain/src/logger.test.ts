import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, scrubSecrets } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('does not throw when meta contains a circular structure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const circular: Record<string, unknown> = { name: 'ctx' };
    circular.self = circular;
    expect(() => logger.error('db failed', { circular })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw on a deeply chained error cause', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root: Error = new Error('root');
    for (let i = 0; i < 50; i += 1) {
      root = new Error(`level-${i}`, { cause: root });
    }
    expect(() => logger.error('nested', { root })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a fallback line when meta is unserializable', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('oops', { value: 1n });
    const line = errorSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"msg":"oops"');
    expect(line).toContain('[unserializable]');
  });
});

describe('scrubSecrets', () => {
  it('redacts sk- style keys and postgres connection strings', () => {
    expect(scrubSecrets('key sk-abc123DEF456')).toContain('[REDACTED]');
    expect(scrubSecrets('postgres://user:pass@host/db')).toContain('[REDACTED]');
  });
});
