import { customType } from 'drizzle-orm/pg-core';

const parsedDim = parseInt(process.env.EMBEDDING_DIMENSION || '768', 10);
if (!Number.isFinite(parsedDim) || parsedDim <= 0) {
  throw new Error(
    `Invalid EMBEDDING_DIMENSION: "${process.env.EMBEDDING_DIMENSION}". ` +
      'Expected a positive integer (default 768).',
  );
}
export const VECTOR_DIM = parsedDim;

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
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
 * always in sync with `content` without manual writes. Used by Session 7
 * hybrid retrieval; not read/written through the ORM directly here.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
  fromDriver(value: unknown): string {
    return typeof value === 'string' ? value : String(value);
  },
});
