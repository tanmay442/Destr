import { describe, it, expect } from 'vitest';
import { buildCoreDeps } from './core';
import { db } from './db';

describe('buildCoreDeps singleton semantics', () => {
  it('returns the same instances on repeated calls with the default env', () => {
    const first = buildCoreDeps();
    const second = buildCoreDeps();
    expect(first).toBe(second);
    expect(first.dbClient).toBe(second.dbClient);
    expect(first.documentRepo).toBe(second.documentRepo);
    expect(first.chatEventBatcher).toBe(second.chatEventBatcher);
    expect(first.ingestQueue).toBe(second.ingestQueue);
    expect(first.answerCache).toBe(second.answerCache);
  });

  it('ignores options on a memoized second call with the default env', () => {
    const first = buildCoreDeps({ flushScheduler: (fn) => fn() });
    const second = buildCoreDeps({ flushScheduler: () => {} });
    expect(second).toBe(first);
  });

  it('constructs a fresh instance when an explicit env is supplied', () => {
    const fresh = buildCoreDeps({ env: { get: () => undefined } });
    expect(fresh).not.toBe(buildCoreDeps());
    expect(fresh.dbClient).not.toBe(buildCoreDeps().dbClient);
  });

  it('shares the module db singleton for the default env', () => {
    expect(buildCoreDeps().dbClient).toBe(db);
  });
});
