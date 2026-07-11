import { type Result, serviceResult } from '../service-result';
import type { QueryStats } from '@app/domain';

export async function recordQuery(
  userId: string,
  query: string,
  deps: { stats: QueryStats },
): Promise<Result<void>> {
  return serviceResult(() => deps.stats.record(userId, query), 'Failed to record query');
}

export async function getTopQueries(
  limit: number,
  deps: { stats: QueryStats },
): Promise<Result<Array<{ q: string; count: number }>>> {
  return serviceResult(() => deps.stats.top(limit), 'Failed to get top queries');
}
