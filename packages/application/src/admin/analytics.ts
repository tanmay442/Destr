import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, TicketRepository, UserRepository, QueryStats,
  ChatEventsRepo, ChatEventMetrics, ChatEventDailyUsage, ChatEventRange,
} from '@app/domain';
import { requireAdminActor } from './authz';

/** Rough blended token prices (USD per 1M tokens) for estimated-cost card. */
const TOKEN_COST_PER_MILLION = { input: 0.15, output: 0.6 } as const;

export interface ChatAnalytics extends ChatEventMetrics {
  topZeroResultQueries: Array<{ q: string; count: number }>;
  usageOverTime: ChatEventDailyUsage[];
  estimatedCostUsd: number;
}

export async function getChatAnalytics(
  input: { actorId: string; range?: ChatEventRange; usageDays?: number },
  deps: { users: UserRepository; chatEvents: ChatEventsRepo },
): Promise<Result<ChatAnalytics>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const [metrics, topZeroResultQueries, usageOverTime] = await Promise.all([
      deps.chatEvents.getMetrics(input.range),
      deps.chatEvents.getTopZeroResultQueries(10, input.range),
      deps.chatEvents.getUsageOverTime(input.usageDays ?? 7),
    ]);
    const estimatedCostUsd =
      (metrics.tokensIn / 1_000_000) * TOKEN_COST_PER_MILLION.input +
      (metrics.tokensOut / 1_000_000) * TOKEN_COST_PER_MILLION.output;
    return ok({ ...metrics, topZeroResultQueries, usageOverTime, estimatedCostUsd });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load chat analytics', e));
  }
}

export interface AnalyticsSummary {
  documentCount: number;
  chunkCount: number;
  ticketCount: number;
  openTicketCount: number;
  usersCount: number;
  topQueries: Array<{ q: string; count: number }>;
  coldStart: boolean;
}

export async function getAnalyticsSummary(
  input: { actorId: string },
  deps: {
    documents: DocumentRepository;
    chunks: ChunkRepository;
    tickets: TicketRepository;
    users: UserRepository;
    stats: QueryStats;
  },
): Promise<Result<AnalyticsSummary>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const [docCount, chunkCount, ticketCount, openTicketCount, usersCount] = await Promise.all([
      deps.documents.list({ limit: 1, offset: 0 }).then((r) => r.total),
      deps.chunks.countForAll(),
      deps.tickets.countAll(),
      deps.tickets.countOpen(),
      deps.users.countAll(),
    ]);
    const topQueries = await deps.stats.top(10);
    return ok({
      documentCount: docCount,
      chunkCount,
      ticketCount,
      openTicketCount,
      usersCount,
      topQueries,
      coldStart: docCount === 0,
    });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load analytics', e));
  }
}
