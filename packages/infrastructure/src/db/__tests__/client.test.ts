import { describe, it, expect } from 'vitest';
import type { EnvSource } from '@app/domain';
import { createDbClient } from '../client';
import { resolveVectorDim } from '../schema-vector';

const emptyEnv: EnvSource = { get: () => undefined };

describe('createDbClient / resolveVectorDim (E2 fail-fast)', () => {
  it('throws when EMBEDDING_DIMENSION is invalid', () => {
    const env: EnvSource = {
      get: (k) => (k === 'EMBEDDING_DIMENSION' ? 'invalid' : undefined),
    };
    expect(() => createDbClient({ env })).toThrow(/Invalid EMBEDDING_DIMENSION/);
  });

  it('defaults to 768 when EMBEDDING_DIMENSION is unset', () => {
    expect(resolveVectorDim(emptyEnv)).toBe(768);
    expect(() => createDbClient({ env: emptyEnv })).not.toThrow();
  });

  it('accepts an explicit vectorDim without reading env', () => {
    const env: EnvSource = {
      get: (k) => (k === 'EMBEDDING_DIMENSION' ? 'invalid' : undefined),
    };
    expect(() => createDbClient({ env, vectorDim: 1024 })).not.toThrow();
  });
});