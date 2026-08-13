import { customType } from 'drizzle-orm/pg-core';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';

export function resolveVectorDim(env?: EnvSource): number {
  const raw = (env ?? defaultProcessEnv).get('EMBEDDING_DIMENSION');
  const parsedDim = parseInt(raw || '768', 10);
  if (!Number.isFinite(parsedDim) || parsedDim <= 0) {
    throw new Error(
      `Invalid EMBEDDING_DIMENSION: "${raw}". ` +
        'Expected a positive integer (default 768).',
    );
  }
  return parsedDim;
}

/** @deprecated Module-load evaluation kept for compat (same semantics as before E2); resolve at call time via resolveVectorDim(env?). */
export const VECTOR_DIM: number = resolveVectorDim();

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${resolveVectorDim()})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === 'string') {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((s) => Number(s.trim()));
    }
    if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
      return value;
    }
    throw new Error(`Unexpected vector value from driver: ${typeof value}`);
  },
});

/**
 * Full-text-search vector column (PostgreSQL `tsvector`).
 * Materialized as a STORED generated column (see `chunks.tsv`) so it is
 * always in sync with `content` without manual writes. Used by hybrid
 * retrieval; not read/written through the ORM directly here.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
  fromDriver(value: unknown): string {
    return typeof value === 'string' ? value : String(value);
  },
});
