import { ok, type Result } from '@app/domain';
import type { QueryStats } from '@app/domain';

export async function recordQuery(
  userId: string,
  query: string,
  deps: { stats: QueryStats },
): Promise<Result<void>> {
  await deps.stats.record(userId, query);
  return ok(undefined);
}

export async function getTopQueries(
  limit: number,
  deps: { stats: QueryStats },
): Promise<Result<Array<{ q: string; count: number }>>> {
  return ok(await deps.stats.top(limit));
}
