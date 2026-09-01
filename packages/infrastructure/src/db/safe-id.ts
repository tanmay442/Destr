/**
 * Convert a PostgreSQL numeric identifier to the application's JSON-safe
 * representation. Drizzle's `bigserial({ mode: 'number' })` intentionally
 * keeps the existing domain `number` contract, so every high-growth ID that
 * crosses the database boundary must pass this guard before it is returned,
 * used in a pagination cursor, or used to build a deletion batch.
 */
export function toSafeDatabaseId(value: unknown, label: string): number {
  const numeric = (() => {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return Number.NaN;
  })();

  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new RangeError(`Database identifier ${label} is outside the JSON-safe integer range`);
  }
  return numeric;
}
