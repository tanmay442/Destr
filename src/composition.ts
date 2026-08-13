import {
  ingestFile, searchChunks, listUsers, setUserRole, touchLastSeen,
  getUserByClerkId, logDocumentEvent, logTicketEvent,
  enforceRateLimit, listDocuments, uploadPdf,
  softDeleteDocument, restoreDocument, listTickets, updateTicket,
  createTicket,
  isTicketStatus, TICKET_STATUSES,
  getDocumentById, hardDeleteDocument, replacePdf,
  recountChunksForDocument, recountChunksForAllDocuments,
  getAnalyticsSummary, getChatAnalytics, getAnalyticsTrends,
  getDocumentAnalytics, submitChatFeedback,
  getTicketIntelligence,
  listAudit, logSettingsChange,
  prepareIngest,
  uploadPrechunkedMarkdown,
  reingestAll,
  agenticSearch,
  type IngestDeps, type SearchDeps, type RateLimitDeps,
  type AgenticDeps,
} from '@app/application';
import { Db, Llm, Auth, Pdf, Storage, Queue, Markdown, Chunking, answerCacheKey } from '@app/infrastructure';
import {
  RRF_K, LEXICAL_WEIGHT, RERANK_TOP_N, CANDIDATE_POOL,
  OUT_OF_DOMAIN_THRESHOLD, CCH_ENABLED,
  loadEnvConfig, defaultProcessEnv,
} from '@app/infrastructure/config';
import type { MyUIMessage } from '@/chat/types';
import type { DocumentRow, LogLevel } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import { configureLogger, ForbiddenError, UnauthorizedError, unwrap, err, ok, NotFoundError, ExternalServiceError, type Result, type BlobStorage, type IngestQueue, type RateLimiter, type Reranker } from '@app/domain';
const authAdapter = Auth.createAuthAdapter();

const requireAdmin = authAdapter.requireAdmin;
const requireSession = authAdapter.requireSession;
const getAppSession = authAdapter.getAppSession;
import { createHash } from 'node:crypto';
import { appConfig } from './lib/config';
import { getRuntimeConfig } from './lib/config/runtime';
import { logger } from './lib/logger';
import { respond, respondResult } from './lib/http';
import { MAX_LIST_LIMIT } from '@app/domain';

const cfg = loadEnvConfig();
configureLogger(cfg.LOG_LEVEL as LogLevel);

const systemClock = { now: () => new Date() };
const systemHasher = { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') };

const bind = <Args extends unknown[], T>(
  fn: (...args: Args) => Promise<Result<T>>,
  ...bound: Args
): Promise<Result<T>> => fn(...bound);

const dbClient = Db.createDbClient({ env: defaultProcessEnv });
const documentRepo = Db.createDocumentRepo(dbClient);
const chunkRepo = Db.createChunkRepo(dbClient);
const settingsRepo = Db.createSettingsRepo(dbClient);
const chatEventBatcher = Db.createChatEventsRepo(dbClient);
const chatFeedbackRepo = Db.createChatFeedbackRepo(dbClient);

const embeddingService = Llm.getEmbeddingService();

const blobStorage: BlobStorage = Storage.createBlobStorage();

if (process.env.NODE_ENV === 'production' && (process.env.BLOB_STORAGE_PROVIDER ?? 'filesystem') === 'filesystem') {
  logger.warn('BLOB_STORAGE_PROVIDER=filesystem with NODE_ENV=production: PDFs are written to the ephemeral local filesystem and will be lost between invocations. Use r2 or s3 in production.');
}

if (process.env.NODE_ENV === 'production' && !process.env.UPSTASH_REDIS_REST_URL) {
  logger.warn('NODE_ENV=production without UPSTASH_REDIS_REST_URL: answer cache and rate limiting fall back to in-memory state that is not shared across instances.');
}

const ingestQueue: IngestQueue = Queue.createIngestQueue({
  ingest: async (documentId: number) => {
    const result = await ingestQueuedDocumentStandalone(documentId);
    if (!result.ok) throw new Error(`Inline ingest failed for document ${documentId}: ${result.error.message}`);
  },
});

async function ingestQueuedDocumentStandalone(
  documentId: number,
): Promise<Result<{ status: 'done' | 'already-done' | 'busy'; chunks: number }>> {
  const doc = await documentRepo.findById(documentId);
  if (!doc) return err(new NotFoundError(`Document not found: ${documentId}`));
  if (doc.ingestStatus === 'done') return ok({ status: 'already-done', chunks: 0 });
  if (doc.ingestStatus === 'ingesting') return ok({ status: 'busy', chunks: 0 });
  if (!doc.storageKey) return err(new NotFoundError(`Document ${documentId} has no stored blob`));

  // Claim before the expensive parse/embed so concurrent deliveries can never
  // both pay for it; losers report `busy` and the winner covers the whole phase.
  const claimed = await documentRepo.claimIngest(documentId);
  if (!claimed) return ok({ status: 'busy', chunks: 0 });

  const requeue = () => documentRepo.updateIngestStatus(documentId, 'queued').catch(() => {});

  let buffer: Buffer;
  try {
    buffer = await blobStorage.get(doc.storageKey);
  } catch (e) {
    await requeue();
    return err(new ExternalServiceError('Blob read failed', e));
  }

  // Skip the work if the row was replaced or deleted after we claimed it.
  const current = await documentRepo.findById(documentId);
  if (!current || current.fileHash !== systemHasher.sha256(buffer)) {
    await requeue();
    return ok({ status: 'busy', chunks: 0 });
  }

  const prepared = await prepareIngest({ documentId, fileName: doc.fileName, buffer }, await resolveIngestDeps());
  if (!prepared.ok) {
    await requeue();
    return prepared;
  }

  try {
    await Db.transactionRunner.run(async (tx) => {
      await tx.chunks.deleteByDocumentId(documentId);
      await tx.chunks.insertMany(prepared.value.rows);
      await tx.documents.updateIngestStatus(documentId, 'done');
    });
  } catch (e) {
    await requeue();
    return err(new ExternalServiceError('Chunk insert failed', e));
  }
  return ok({ status: 'done', chunks: prepared.value.chunks });
}

const ingestDeps: Omit<IngestDeps, 'chunkingStrategy'> = {
  documents: documentRepo, chunks: chunkRepo,
  embeddings: embeddingService, hasher: systemHasher,
  pdfParser: Pdf.unpdfParser, textSplitter: Pdf.langchainSplitter,
  contentParser: Pdf.unpdfParser,
  runner: Db.transactionRunner,
  summarizer: Llm.docSummarizer,
  cchEnabled: CCH_ENABLED,
};

function buildChunkingStrategy(cfg: AppConfig) {
  return Chunking.getChunkingStrategy(cfg.chunkingStrategy, {
    embeddings: embeddingService,
    parentSize: cfg.parentChunkSize,
    childSize: cfg.childChunkSize,
  });
}

async function resolveIngestDeps(): Promise<IngestDeps> {
  const cfg = await getRuntimeConfig();
  return { ...ingestDeps, chunkingStrategy: buildChunkingStrategy(cfg) };
}
export type RerankerStatus = { ok: boolean; reason?: string | undefined };
const rerankerRegistry = new Map<string, { reranker?: Reranker | undefined; status: RerankerStatus }>([
  ['cosine', { reranker: undefined, status: { ok: true } }],
  [
    'cohere',
    process.env.COHERE_API_KEY
      ? { reranker: Llm.getReranker('cohere'), status: { ok: true } }
      : { reranker: undefined, status: { ok: false, reason: 'COHERE_API_KEY not set' } },
  ],
  [
    'local',
    process.env.VERCEL
      ? { reranker: undefined, status: { ok: false, reason: 'local reranker unavailable on Vercel serverless' } }
      : { reranker: Llm.getReranker('local'), status: { ok: true } },
  ],
]);

export function availableRerankers(): Map<string, RerankerStatus> {
  return new Map([...rerankerRegistry].map(([name, entry]) => [name, entry.status]));
}

export function resolveReranker(cfg: AppConfig): Reranker | undefined {
  return rerankerRegistry.get(cfg.rerankerProvider)?.reranker;
}

function getSearchDeps(cfg: AppConfig): SearchDeps {
  return { chunks: chunkRepo, embeddings: embeddingService, reranker: resolveReranker(cfg) };
}

function getAgenticDeps(cfg: AppConfig): AgenticDeps {
  const graders = Llm.getGraders(undefined, cfg.gradeModel);
  if (!graders.queryRewriter || !graders.documentGrader) {
    throw new ExternalServiceError('Agentic retrieval is disabled (AGENTIC_ENABLED=false) but retrievalMode is agentic.');
  }
  return {
    search: getSearchDeps(cfg),
    queryRewriter: graders.queryRewriter,
    documentGrader: graders.documentGrader,
    retrieveLimit: cfg.agenticRetrieveLimit,
    maxRetries: cfg.agenticMaxRetries,
    stepBudget: cfg.agentStepBudget,
    outOfDomainThreshold: OUT_OF_DOMAIN_THRESHOLD,
  };
}
const rateLimiter: RateLimiter =
  process.env.UPSTASH_REDIS_REST_URL ? Auth.createUpstashRateLimiter() : Auth.lruRateLimiter;

function createAnswerCache() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try {
      return Auth.createUpstashAnswerCache();
    } catch (e) {
      logger.error(
        'UPSTASH_REDIS_REST_URL is set but the Upstash answer cache could not be initialized; falling back to in-memory cache. Provide UPSTASH_REDIS_REST_TOKEN or unset UPSTASH_REDIS_REST_URL.',
        { error: e },
      );
      return Auth.createInMemoryAnswerCache();
    }
  }
  return Auth.createInMemoryAnswerCache();
}

const rateLimitDeps: RateLimitDeps = { limiter: rateLimiter };

function createComposition() {
  const auditDeps = { audit: Db.auditRepo };
  const userDeps = { users: Db.userRepo };
  const txRunner = Db.transactionRunner;

  return {
    ingestFile: async (input: Parameters<typeof ingestFile>[0]) => bind(ingestFile, input, await resolveIngestDeps()),
    searchChunks: (cfg: AppConfig, q: string, o: Parameters<typeof searchChunks>[1]) =>
      bind(
        searchChunks,
        q,
        {
          ...o,
          threshold: cfg.similarityThreshold,
          hybridEnabled: cfg.hybridEnabled,
          mode: cfg.parentChildMode,
          parentChildWindow: cfg.parentChildWindow,
          rrfK: o.rrfK ?? RRF_K,
          lexicalWeight: o.lexicalWeight ?? LEXICAL_WEIGHT,
          rerankTopN: o.rerankTopN ?? RERANK_TOP_N,
          candidateLimit: o.candidateLimit ?? CANDIDATE_POOL,
        },
        getSearchDeps(cfg),
      ),
    agenticSearch: async (cfg: AppConfig, query: string) => {
      try {
        return await agenticSearch(query, getAgenticDeps(cfg));
      } catch (e) {
        return err(new ExternalServiceError('Agentic retrieval unavailable', e));
      }
    },
    getHallucinationGrader: (cfg: AppConfig) => Llm.getGraders(undefined, cfg.gradeModel).hallucinationGrader?.grade ?? null,
    getSearchDeps,
    getAgenticDeps,
    resolveReranker,
    availableRerankers,
    listUsers: (input: Parameters<typeof listUsers>[0]) => bind(listUsers, input, userDeps),
    setUserRole: (input: Parameters<typeof setUserRole>[0]) =>
      bind(setUserRole, input, { ...userDeps, ...auditDeps, runner: txRunner, syncClerkRole: Auth.syncClerkUserRole }),
    touchLastSeen: (id: string) => bind(touchLastSeen, id, userDeps),
    getUserByClerkId: (id: string) => bind(getUserByClerkId, id, userDeps),
    logDocumentEvent: (input: Parameters<typeof logDocumentEvent>[0]) => bind(logDocumentEvent, input, auditDeps),
    logSettingsChange: (input: Parameters<typeof logSettingsChange>[0]) => logSettingsChange(input, auditDeps),
    logTicketEvent: (input: Parameters<typeof logTicketEvent>[0]) => bind(logTicketEvent, input, auditDeps),
    logUserAudit: (input: { action: string; actorId: string; targetId: string }) =>
      auditDeps.audit.logEvent({ kind: 'user', action: input.action, actorId: input.actorId, targetType: 'user', targetId: input.targetId }),
    enforceRateLimit: (input: Parameters<typeof enforceRateLimit>[0]) => bind(enforceRateLimit, input, rateLimitDeps),
    listDocuments: (input: Parameters<typeof listDocuments>[0]) =>
      bind(listDocuments, input, { documents: documentRepo, chunks: chunkRepo, ...userDeps }),
    uploadPdf: async (input: Parameters<typeof uploadPdf>[0]) =>
      bind(uploadPdf, input, { ...(await resolveIngestDeps()), ...auditDeps, runner: txRunner, blobStorage, ingestQueue, ...userDeps }),
    softDeleteDocument: (input: Parameters<typeof softDeleteDocument>[0]) =>
      bind(softDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, ...userDeps }),
    restoreDocument: (id: number, actorId: string) =>
      bind(restoreDocument, id, actorId, { documents: documentRepo, ...auditDeps, clock: systemClock, runner: txRunner, ...userDeps }),
    listTickets: (input: Parameters<typeof listTickets>[0]) => bind(listTickets, input, { tickets: Db.ticketRepo, ...userDeps }),
    updateTicket: (input: Parameters<typeof updateTicket>[0]) =>
      bind(updateTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    createTicket: (input: Parameters<typeof createTicket>[0]) =>
      bind(createTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    getDocumentById: (id: number, opts?: { includeDeleted?: boolean | undefined }) => getDocumentById(id, { documents: documentRepo }, opts),
    hardDeleteDocument: (input: { documentId: number; actorId: string }) =>
      bind(hardDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, blobStorage, ...userDeps }),
    replacePdf: async (input: { documentId: number; fileName: string; buffer: Buffer; actorId: string }) =>
      bind(replacePdf, input, { ...(await resolveIngestDeps()), ...auditDeps, runner: txRunner, blobStorage, ingestQueue, ...userDeps }),
    uploadChunkedMarkdown: (input: {
      fileName: string;
      mdText: string;
      delimiter?: string | undefined;
      uploadedBy: string;
      pdfBuffer?: Buffer | undefined;
      pdfFileName?: string | undefined;
    }) =>
      bind(uploadPrechunkedMarkdown, input, {
        documents: documentRepo,
        chunks: chunkRepo,
        embeddings: embeddingService,
        hasher: systemHasher,
        blobStorage,
        runner: txRunner,
        markdownParser: Markdown.markdownParser,
        summarizer: Llm.docSummarizer,
        cchEnabled: CCH_ENABLED,
      }),
    ingestQueuedDocument: (documentId: number) => ingestQueuedDocumentStandalone(documentId),
    recountChunksForDocument: (id: number) => bind(recountChunksForDocument, id, { chunks: chunkRepo }),
    recountChunksForAllDocuments: () => bind(recountChunksForAllDocuments, { chunks: chunkRepo }),
    reingestAll: () =>
      reingestAll({ documents: documentRepo, queue: ingestQueue, chunks: chunkRepo }),
    sweepStaleQueued: () =>
      Queue.createQueuedSweeper({
        listStaleQueued: (olderThan) => documentRepo.listStaleQueued(olderThan),
        failDocument: (id) => documentRepo.failDocument(id),
      }).sweep(),
    getAnalyticsSummary: (input: { actorId: string }) =>
      bind(getAnalyticsSummary, input, { documents: documentRepo, chunks: chunkRepo, tickets: Db.ticketRepo, ...userDeps }),
    getChatAnalytics: (input: Parameters<typeof getChatAnalytics>[0]) =>
      bind(getChatAnalytics, input, { ...userDeps, chatEvents: chatEventBatcher }),
    getAnalyticsTrends: (input: Parameters<typeof getAnalyticsTrends>[0]) =>
      bind(getAnalyticsTrends, input, { ...userDeps, chatEvents: chatEventBatcher }),
    getDocumentAnalytics: (input: Parameters<typeof getDocumentAnalytics>[0]) =>
      bind(getDocumentAnalytics, input, { ...userDeps, chatEvents: chatEventBatcher, feedback: chatFeedbackRepo }),
    getTicketIntelligence: (input: Parameters<typeof getTicketIntelligence>[0]) =>
      bind(getTicketIntelligence, input, { ...userDeps, chatEvents: chatEventBatcher, tickets: Db.ticketRepo }),
    submitChatFeedback: (input: Parameters<typeof submitChatFeedback>[0]) =>
      bind(submitChatFeedback, input, { feedback: chatFeedbackRepo }),
    listAudit: (input: Parameters<typeof listAudit>[0]) => bind(listAudit, input, { ...auditDeps, ...userDeps }),
    db: dbClient,
    schema: Db.schema,
    blobStorage,
    getEmbeddingModel: Llm.getEmbeddingModel,
    getChatModel: Llm.getChatModel,
    getEmbeddingModelId: Llm.getEmbeddingModelId,
    answerCacheKey,
    answerCache: createAnswerCache(),
    settingsRepo,
    chatEventBatcher,
    session: Auth.clerkSessionStore,
    rateLimit: async (key: string, opts: { limit: number; windowMs: number }) =>
      rateLimiter.check(key, opts),
  };
}

export { appConfig, isTicketStatus, TICKET_STATUSES, type MyUIMessage };
export { requireAdmin, requireSession, getAppSession, ForbiddenError, unwrap };
export { respond, respondResult };
export { TRACE_ENABLED, MD_CHUNK_DELIMITER, UPLOAD_CHUNKED_MAX_MD_BYTES, UPLOAD_CHUNKED_MAX_PDF_BYTES } from '@app/infrastructure/config';


export type Composition = ReturnType<typeof createComposition>;

let _composition: Composition | null = null;
export function getComposition(): Composition {
  if (!_composition) _composition = createComposition();
  return _composition;
}

let _vectorCheckStarted = false;
export function startVectorDimensionCheck(): void {
  if (_vectorCheckStarted) return;
  _vectorCheckStarted = true;
  Db.validateVectorDimension().catch((e: unknown) => {
    logger.error('Embedding dimension validation failed at startup', { error: e });
  });
}

let _rerankerCheckStarted = false;
export function startLocalRerankerCheck(): void {
  if (_rerankerCheckStarted) return;
  _rerankerCheckStarted = true;
  if (process.env.RERANKER_PROVIDER !== 'local') return;
  Llm.checkLocalRerankerAvailable().then((available) => {
    if (available) return;
    logger.warn('RERANKER_PROVIDER=local but @xenova/transformers is not installed; reranking silently falls back to cosine ordering. Install the optional dependency or set RERANKER_PROVIDER=cosine/cohere.');
    rerankerRegistry.set('local', { reranker: undefined, status: { ok: false, reason: '@xenova/transformers is not installed' } });
  });
}

export function assertSameOrigin(req: Request): Response | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return new Response('Forbidden', { status: 403 });
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return new Response('Forbidden', { status: 403 });
  const reqHost = req.headers.get('host');
  if (reqHost && originHost !== reqHost) return new Response('Forbidden', { status: 403 });
  return null;
}

export async function requireAdminRoute(req?: Request): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof requireAdmin>>; comp: Composition }
  | { ok: false; response: Response }
> {
  if (req) {
    const csrf = assertSameOrigin(req);
    if (csrf) return { ok: false, response: csrf };
  }
  try {
    const session = await requireAdmin();
    return { ok: true, session, comp: getComposition() };
  } catch (err) {
    if (err instanceof UnauthorizedError) return { ok: false, response: respond(new UnauthorizedError()) };
    if (err instanceof ForbiddenError) return { ok: false, response: respond(new ForbiddenError()) };
    logger.error('requireAdminRoute failed', { error: err });
    return { ok: false, response: new Response('Service Unavailable', { status: 503 }) };
  }
}

export function parseQueryPagination(
  url: URL,
  defaults: { limit?: number; offset?: number } = {},
): { limit: number; offset: number } {
  const rawLimit = Number(url.searchParams.get('limit') ?? defaults.limit ?? 25);
  const rawOffset = Number(url.searchParams.get('offset') ?? defaults.offset ?? 0);
  return {
    limit: Math.min(Math.max(Math.floor(Number.isFinite(rawLimit) ? rawLimit : (defaults.limit ?? 25)), 1), MAX_LIST_LIMIT),
    offset: Math.max(Math.floor(Number.isFinite(rawOffset) ? rawOffset : (defaults.offset ?? 0)), 0),
  };
}

export function parsePageParam(raw: string | undefined, fallback = 1): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export async function requireAdminGet(
  req: Request,
): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof requireAdmin>>; comp: Composition; url: URL }
  | { ok: false; response: Response }
> {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth;
  return { ok: true, session: auth.session, comp: auth.comp, url: new URL(req.url) };
}

export async function requireAdminDocument(
  context: { params: Promise<{ id: string }> },
  opts: { allowDeleted?: boolean } = {},
): Promise<
  | {
      ok: true;
      session: Awaited<ReturnType<typeof requireAdmin>>;
      comp: Composition;
      document: DocumentRow;
    }
  | { ok: false; response: Response }
> {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth;
  const { id } = await context.params;
  const docId = Number(id);
  if (!Number.isInteger(docId)) return { ok: false, response: new Response('Invalid id', { status: 400 }) };
  const r = await auth.comp.getDocumentById(docId, { includeDeleted: opts.allowDeleted });
  if (!r.ok) return { ok: false, response: respond(r.error) };
  const doc = r.value.document;
  if (!doc) return { ok: false, response: new Response('Not found', { status: 404 }) };
  if (!opts.allowDeleted && doc.deletedAt) return { ok: false, response: new Response('Gone', { status: 410 }) };
  if (!doc.storageKey) return { ok: false, response: new Response('File unavailable', { status: 404 }) };
  return { ok: true, session: auth.session, comp: auth.comp, document: doc };
}
