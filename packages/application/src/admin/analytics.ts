import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { DocumentRepository, ChunkRepository, TicketRepository, UserRepository, QueryStats } from '@app/domain';

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
  deps: {
    documents: DocumentRepository;
    chunks: ChunkRepository;
    tickets: TicketRepository;
    users: UserRepository;
    stats: QueryStats;
  },
): Promise<Result<AnalyticsSummary>> {
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
