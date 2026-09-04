/** Per-turn chat metrics. `mode`: 'agentic' or 'vector'. */
export interface ChatEventInput {
  userId: string | null;
  query: string | null;
  mode: 'agentic' | 'vector';
  turnId?: string | null;
  retrieveMs?: number | null;
  generateMs?: number | null;
  totalMs?: number | null;
  hitCount?: number | null;
  maxSimilarity?: number | null;
  outOfDomain?: boolean;
  hallucinationBlocked?: boolean;
  cacheHit?: boolean;
  ticketCreated?: boolean;
  citationCount?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  meta?: Record<string, unknown>;
}

export interface ChatEventRange {
  from?: Date | undefined;
  to?: Date | undefined;
}

/** Aggregate per-turn metrics for the analytics dashboard. */
export interface ChatEventMetrics {
  total: number;
  ticketsCreated: number;
  ticketCreationRate: number;
  selfServeSuccessRate: number;
  outOfDomainRate: number;
  zeroResultRate: number;
  cacheHitRate: number;
  hallucinationRate: number;
  agenticRetryRate: number;
  retrieveP50Ms: number;
  retrieveP95Ms: number;
  generateP50Ms: number;
  generateP95Ms: number;
  totalP50Ms: number;
  totalP95Ms: number;
  tokensIn: number;
  tokensOut: number;
  uniqueUsers: number;
  byMode: Array<{ mode: 'agentic' | 'vector'; total: number }>;
}

export interface ChatEventDailyUsage {
  day: string;
  total: number;
  uniqueUsers: number;
}

export interface ChatDailyTrendRow {
  day: string;
  total: number;
  hallucinations: number;
  outOfDomain: number;
  cacheHits: number;
  ticketsCreated: number;
  selfServe: number;
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

export interface QueryLengthBuckets {
  short: number;
  medium: number;
  long: number;
}

export interface ModeComparison {
  mode: 'agentic' | 'vector';
  total: number;
  avgTokensPerQuery: number;
  avgMaxSimilarity: number;
  ticketRate: number;
  hallucinationRate: number;
  totalP50Ms: number;
  totalP95Ms: number;
  queryLengthBuckets: QueryLengthBuckets;
}

export interface CacheBusterQuery {
  query: string;
  misses: number;
}

export interface DocumentUtilityRow {
  documentId: number;
  fileName: string | null;
  retrievalCount: number;
  p95Similarity: number;
  ticketConversionRate: number;
}

export interface TurnToTicketBucket {
  label: string;
  turns: number;
  count: number;
}

export interface TurnsToTicket {
  ticketSessions: number;
  avgTurns: number;
  buckets: TurnToTicketBucket[];
}

export interface TicketResponseTimes {
  medianFirstResponseMs: number;
  medianResolutionMs: number;
  respondedCount: number;
  resolvedCount: number;
}

export interface ZeroHitDocument {
  documentId: number;
  fileName: string | null;
  createdAt: string;
}

export type FeedbackUpsertResult = 'ok' | 'not_found' | 'forbidden';

export interface ChatEvent {
  id: number;
  turnId: string | null;
  userId: string | null;
  query: string | null;
  mode: 'agentic' | 'vector';
  retrieveMs: number | null;
  generateMs: number | null;
  totalMs: number | null;
  hitCount: number | null;
  maxSimilarity: number | null;
  outOfDomain: boolean;
  hallucinationBlocked: boolean;
  cacheHit: boolean;
  ticketCreated: boolean;
  citationCount: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface ChatDailyQualityRow {
  day: string;
  avgFaithfulness: number;
  avgRetrievalRelevance: number;
}

export interface FeedbackSummary {
  up: number;
  down: number;
  total: number;
  totalEvents: number;
}

export interface DocumentSentiment {
  documentId: number;
  fileName: string | null;
  up: number;
  down: number;
}

export interface ThumbsDownDoc {
  documentId: number;
  fileName: string | null;
  down: number;
}

export interface ChatEventWriter {
  record(event: ChatEventInput): void;
  flush(): Promise<void>;
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}

export interface ChatEventReader {
  getQualitySamples(limit: number, filter: { blocked?: boolean }): Promise<ChatEvent[]>;
  getDailyTrends(days: number): Promise<ChatDailyTrendRow[]>;
  getDailyQuality(days: number): Promise<ChatDailyQualityRow[]>;
  getJudgeAverages(days?: number): Promise<{ avgFaithfulness: number; avgRetrievalRelevance: number }>;
  getMetrics(range?: ChatEventRange): Promise<ChatEventMetrics>;
  getUsageOverTime(days: number): Promise<ChatEventDailyUsage[]>;
  getModeComparison(range?: ChatEventRange): Promise<ModeComparison[]>;
  getCacheBusterQueries(limit: number, range?: ChatEventRange): Promise<CacheBusterQuery[]>;
  getDocumentUtility(limit: number, range?: ChatEventRange): Promise<DocumentUtilityRow[]>;
  getZeroHitDocuments(limit: number): Promise<ZeroHitDocument[]>;
  getTurnsToTicket(range?: ChatEventRange): Promise<TurnsToTicket>;
}

export interface ChatEventRetention {
  refreshDailyStats(): Promise<void>;
}

export interface ChatEventPurge {
  purgeOlderThan(cutoff: Date): Promise<{ deletedCount: number }>;
  purgeUserData(userId: string): Promise<{ deletedCount: number }>;
  anonymizeUserData(userId: string): Promise<{ updatedCount: number }>;
}

/** Per-turn metrics store. Holds entries in memory, flushes on size/interval threshold. */
export type ChatEventsRepo = ChatEventWriter & ChatEventReader & ChatEventRetention & ChatEventPurge;

export type QualityReviewVerdict = 'good' | 'bad' | 'docs_missing';

export interface QualityReviewInput {
  turnId: string;
  reviewerId: string;
  verdict: QualityReviewVerdict;
  note?: string | null;
}

export interface QualityReviewRow {
  id: number;
  turnId: string | null;
  reviewerId: string | null;
  verdict: QualityReviewVerdict;
  note: string | null;
  createdAt: Date;
}

export interface QualityReviewsRepo {
  create(input: QualityReviewInput): Promise<QualityReviewRow>;
  listRecent(limit: number): Promise<QualityReviewRow[]>;
}

export interface ChatFeedbackRepo {
  upsertFeedback(input: {
    turnId: string;
    userId: string;
    feedback: 1 | -1;
    documentIds: number[];
    chunkIds: number[];
  }): Promise<FeedbackUpsertResult>;
  getFeedbackSummary(range?: ChatEventRange): Promise<FeedbackSummary>;
  getDocumentSentiment(limit: number, range?: ChatEventRange): Promise<DocumentSentiment[]>;
  getThumbsDownDocs(limit: number, range?: ChatEventRange): Promise<ThumbsDownDoc[]>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredChatMessage {
  id: number;
  turnId: string | null;
  role: 'user' | 'assistant';
  content: unknown;
  createdAt: Date;
}

export interface AppendChatTurnInput {
  conversationId: string;
  userId: string;
  turnId: string;
  /** Only read when creating the conversation. */
  title?: string | undefined;
  /** Client message id whose stored pair this turn replaces (regenerate). */
  retryOfMessageId?: string | undefined;
  userMessage: unknown;
  assistantMessage: unknown;
}

/** Persisted saved chats. Ownership is baked in: every method takes the owning `userId` first. */
export interface ChatHistoryRepo {
  appendTurn(input: AppendChatTurnInput): Promise<{ conversationId: string }>;
  listConversations(
    userId: string,
    opts: { limit: number; offset: number },
  ): Promise<ConversationSummary[]>;
  getConversation(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationSummary; messages: StoredChatMessage[] } | null>;
  renameConversation(userId: string, conversationId: string, title: string): Promise<boolean>;
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  countConversations(userId: string): Promise<number>;
  purgeOlderThan(cutoff: Date): Promise<{ deletedConversations: number; deletedMessages: number }>;
  purgeUserData(userId: string): Promise<{ deletedConversations: number; deletedMessages: number }>;
}
