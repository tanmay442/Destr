import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, TicketRepository, UserRepository, QueryStats,
  ChatEventsRepo, ChatEventMetrics, ChatEventDailyUsage, ChatEventRange,
  ModeComparison, CacheBusterQuery, StuckSessions,
  ChatFeedbackRepo, DocumentUtilityRow, ZeroHitDocument,
  FeedbackSummary, DocumentSentiment, ThumbsDownDoc,
} from '@app/domain';
import { requireAdminActor } from './authz';

const DEFAULT_DOCUMENT_LIMIT = 20;

/** Rough blended token prices (USD per 1M tokens) for estimated-cost card. */
const TOKEN_COST_PER_MILLION = { input: 0.15, output: 0.6 } as const;

const DEFAULT_TREND_DAYS = 84;
const CACHE_BUSTER_LIMIT = 5;

export interface ChatAnalytics extends ChatEventMetrics {
  topZeroResultQueries: Array<{ q: string; count: number }>;
  usageOverTime: ChatEventDailyUsage[];
  estimatedCostUsd: number;
  modeComparison: ModeComparison[];
  cacheBusterQueries: CacheBusterQuery[];
  stuckSessions: StuckSessions;
}

export async function getChatAnalytics(
  input: { actorId: string; range?: ChatEventRange; usageDays?: number },
  deps: { users: UserRepository; chatEvents: ChatEventsRepo },
): Promise<Result<ChatAnalytics>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const [metrics, topZeroResultQueries, usageOverTime, modeComparison, cacheBusterQueries, stuckSessions] =
      await Promise.all([
        deps.chatEvents.getMetrics(input.range),
        deps.chatEvents.getTopZeroResultQueries(10, input.range),
        deps.chatEvents.getUsageOverTime(input.usageDays ?? 7),
        deps.chatEvents.getModeComparison(input.range),
        deps.chatEvents.getCacheBusterQueries(CACHE_BUSTER_LIMIT, input.range),
        deps.chatEvents.getStuckSessions(input.range),
      ]);
    const estimatedCostUsd =
      (metrics.tokensIn / 1_000_000) * TOKEN_COST_PER_MILLION.input +
      (metrics.tokensOut / 1_000_000) * TOKEN_COST_PER_MILLION.output;
    return ok({
      ...metrics,
      topZeroResultQueries,
      usageOverTime,
      estimatedCostUsd,
      modeComparison,
      cacheBusterQueries,
      stuckSessions,
    });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load chat analytics', e));
  }
}

export interface AnalyticsTrendPoint {
  day: string;
  total: number;
  hallucinationRate: number;
  outOfDomainRate: number;
  cacheHitRate: number;
  ticketCreationRate: number;
  selfServeSuccessRate: number;
  avgMaxSimilarity: number;
  totalP50Ms: number;
  totalP95Ms: number;
  retrieveP50Ms: number;
  retrieveP95Ms: number;
  generateP50Ms: number;
  generateP95Ms: number;
  tokensIn: number;
  tokensOut: number;
}

export interface AnalyticsTrends {
  days: number;
  points: AnalyticsTrendPoint[];
}

export async function getAnalyticsTrends(
  input: { actorId: string; days?: number },
  deps: { users: UserRepository; chatEvents: ChatEventsRepo },
): Promise<Result<AnalyticsTrends>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  const days = input.days && input.days > 0 ? Math.floor(input.days) : DEFAULT_TREND_DAYS;
  try {
    const rows = await deps.chatEvents.getDailyTrends(days);
    const rate = (n: number, d: number) => (d > 0 ? n / d : 0);
    const points: AnalyticsTrendPoint[] = rows.map((r) => ({
      day: r.day,
      total: r.total,
      hallucinationRate: rate(r.hallucinations, r.total),
      outOfDomainRate: rate(r.outOfDomain, r.total),
      cacheHitRate: rate(r.cacheHits, r.total),
      ticketCreationRate: rate(r.ticketsCreated, r.total),
      selfServeSuccessRate: rate(r.selfServe, r.total),
      avgMaxSimilarity: r.avgMaxSimilarity,
      totalP50Ms: r.totalP50Ms,
      totalP95Ms: r.totalP95Ms,
      retrieveP50Ms: r.retrieveP50Ms,
      retrieveP95Ms: r.retrieveP95Ms,
      generateP50Ms: r.generateP50Ms,
      generateP95Ms: r.generateP95Ms,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    }));
    return ok({ days, points });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load analytics trends', e));
  }
}

export interface DocumentAnalytics {
  utility: DocumentUtilityRow[];
  zeroHit: ZeroHitDocument[];
  feedback: {
    summary: FeedbackSummary;
    documentSentiment: DocumentSentiment[];
    thumbsDownDocs: ThumbsDownDoc[];
  };
}

export async function getDocumentAnalytics(
  input: { actorId: string; range?: ChatEventRange; limit?: number },
  deps: { users: UserRepository; chatEvents: ChatEventsRepo; feedback: ChatFeedbackRepo },
): Promise<Result<DocumentAnalytics>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_DOCUMENT_LIMIT;
  try {
    const [utility, zeroHit, summary, documentSentiment, thumbsDownDocs] = await Promise.all([
      deps.chatEvents.getDocumentUtility(limit, input.range),
      deps.chatEvents.getZeroHitDocuments(limit),
      deps.feedback.getFeedbackSummary(input.range),
      deps.feedback.getDocumentSentiment(limit, input.range),
      deps.feedback.getThumbsDownDocs(limit, input.range),
    ]);
    return ok({
      utility,
      zeroHit,
      feedback: { summary, documentSentiment, thumbsDownDocs },
    });
  } catch (e) {
    return err(new ExternalServiceError('Failed to load document analytics', e));
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
