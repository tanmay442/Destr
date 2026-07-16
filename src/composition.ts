// Composition root: wires port interfaces to infrastructure adapters.
import {
  ingestFile, searchChunks, listUsers, setUserRole, touchLastSeen,
  getUserByClerkId, logDocumentEvent, logTicketEvent, recordQuery,
  getTopQueries, enforceRateLimit, listDocuments, uploadPdf,
  softDeleteDocument, restoreDocument, listTickets, updateTicket,
  createTicket,
  isTicketStatus, TICKET_STATUSES,
  getDocumentById, hardDeleteDocument, replacePdf,
  recountChunksForDocument, recountChunksForAllDocuments,
  getAnalyticsSummary, listAudit,
  prepareIngest,
  uploadPrechunkedMarkdown,
  reingestAll,
  agenticSearch,
  type IngestDeps, type SearchDeps, type RateLimitDeps,
  type AgenticDeps,
} from '@app/application';
import { Db, Llm, Auth, Pdf, Storage, Queue, Markdown, Chunking, answerCacheKey } from '@app/infrastructure';
const authAdapter = Auth.createAuthAdapter();

const requireAdmin = authAdapter.requireAdmin;
const requireSession = authAdapter.requireSession;
const getAppSession = authAdapter.getAppSession;
import { ForbiddenError, UnauthorizedError, unwrap, err, ok, NotFoundError, ExternalServiceError, type Result, type BlobStorage, type IngestQueue, type RateLimiter, type QueryStats } from '@app/domain';
import { type MyUIMessage } from '@app/application/chat';
import type { DocumentRow } from '@app/domain';
import { createHash } from 'node:crypto';
import { appConfig } from './lib/config';
import { logger } from './lib/logger';
import { respond, respondResult } from './lib/http';
import { MAX_LIST_LIMIT, RERANKER_PROVIDER } from '../config/constants';

const systemClock = { now: () => new Date() };
const systemHasher = { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') };

/** Wrap a Result-returning use-case with partially-applied deps.
 *  Returns the Result directly — the caller inspects `.ok`. */
const bind = <Args extends unknown[], T>(
  fn: (...args: Args) => Promise<Result<T>>,
  ...bound: Args
): Promise<Result<T>> => fn(...bound);

// Reuse the factory functions from repositories.ts instead of
// defining duplicate adapter wrappers here.
const documentRepo = Db.createDocumentRepo(Db.db);
const chunkRepo = Db.createChunkRepo(Db.db);

const embeddingService = Llm.getEmbeddingService();

// Object storage for PDF binaries. Provider is env-swappable via
// BLOB_STORAGE_PROVIDER (filesystem | r2 | s3). Default: filesystem.
const blobStorage: BlobStorage = Storage.createBlobStorage();

// Filesystem storage is ephemeral on serverless/edge — warn so misconfig in
// production is visible rather than silently losing uploaded PDFs.
if (process.env.NODE_ENV === 'production' && (process.env.BLOB_STORAGE_PROVIDER ?? 'filesystem') === 'filesystem') {
  logger.warn('BLOB_STORAGE_PROVIDER=filesystem with NODE_ENV=production: PDFs are written to the ephemeral local filesystem and will be lost between invocations. Use r2 or s3 in production.');
}

// Async ingest queue. QStash-backed when QSTASH_TOKEN is set; a no-op
// (sync mode) otherwise. The upload use-cases enqueue large PDFs here
// and the /api/admin/ingest-worker route drains them.
const ingestQueue: IngestQueue = Queue.createIngestQueue();

const ingestDeps: IngestDeps = {
  documents: documentRepo, chunks: chunkRepo,
  embeddings: embeddingService, hasher: systemHasher,
  pdfParser: Pdf.unpdfParser, textSplitter: Pdf.langchainSplitter,
  // Session 4: strategy-driven chunking is the default path. Both ingest
  // routes (ingestFile + ingestQueuedDocument) share this single resolution.
  contentParser: Pdf.unpdfParser,
  chunkingStrategy: Chunking.getChunkingStrategy(appConfig.chunkingStrategy, {
    embeddings: embeddingService,
    parentSize: appConfig.parentChunkSize,
    childSize: appConfig.childChunkSize,
  }),
  runner: Db.transactionRunner,
  summarizer: Llm.docSummarizer,
};
// Session 6: second-stage reranker. `RERANKER_PROVIDER` selects one of
// three modes (see config/constants.ts): 'cosine' (OG vector ordering, default,
// no reranker loaded), 'local' (on-device Xenova cross-encoder, no key),
// 'cohere' (hosted API, needs COHERE_API_KEY). getReranker() returns
// `undefined` for 'cosine' or for 'cohere' without a key, so searchChunks
// keeps its original behaviour. When a chosen reranker fails at runtime,
// searchChunks automatically falls back to cosine ordering.
const reranker = Llm.getReranker(RERANKER_PROVIDER);
if (RERANKER_PROVIDER !== 'cosine') {
  if (RERANKER_PROVIDER === 'local' && process.env.VERCEL) {
    // Native onnxruntime (~137 MB) + model download can exceed the serverless
    // function cap or fail on a read-only FS — fall back to cosine if so.
    logger.warn(
      'RERANKER_PROVIDER=local on Vercel serverless: the on-device ' +
        'cross-encoder needs native onnxruntime and a model download, which may ' +
        'exceed the function size limit or fail on a read-only FS. If it fails ' +
        'to load, searchChunks falls back to cosine ordering (reranking is ' +
        'effectively disabled on this deployment). To keep reranking on ' +
        'serverless, pre-bake the model into TRANSFORMERS_CACHE in the build.',
    );
  } else if (RERANKER_PROVIDER === 'cohere' && !process.env.COHERE_API_KEY) {
    // getReranker already returns undefined here, but log it so the operator
    // understands why reranking is not active.
    logger.warn(
      'RERANKER_PROVIDER=cohere but COHERE_API_KEY is not set — searchChunks ' +
        'will use cosine ordering (reranking disabled). Set COHERE_API_KEY to ' +
        'enable the hosted reranker.',
    );
  }
}
const searchDeps: SearchDeps = {
  chunks: chunkRepo,
  embeddings: embeddingService,
  reranker,
};

// Session 8: agentic retrieval loop graders (rewrite / grade / hallucination).
// `Llm.getGraders` returns `undefined` for each when AGENTIC_ENABLED=false.
const graders = Llm.getGraders();
const agenticDeps: AgenticDeps | null = graders.queryRewriter && graders.documentGrader && graders.hallucinationGrader
  ? {
      search: searchDeps,
      queryRewriter: graders.queryRewriter,
      documentGrader: graders.documentGrader,
      hallucinationGrader: graders.hallucinationGrader,
    }
  : null;
function createRateLimiter(): RateLimiter {
  if (process.env.UPSTASH_REDIS_REST_URL) return Auth.createUpstashRateLimiter();
  return Auth.lruRateLimiter;
}

function createQueryStats(): QueryStats {
  if (process.env.UPSTASH_REDIS_REST_URL) return Auth.createUpstashQueryStats();
  return Auth.inMemoryQueryStats;
}

// Session 10: answer cache reuses the same Upstash Redis as the rate-limiter
// and query stats (no second connection). Falls back to an in-memory cache when
// Redis is not configured, so the cache toggle works in local/dev + tests.
function createAnswerCache() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try {
      return Auth.createUpstashAnswerCache();
    } catch {
      return Auth.createInMemoryAnswerCache();
    }
  }
  return Auth.createInMemoryAnswerCache();
}

const rateLimitDeps: RateLimitDeps = { limiter: createRateLimiter() };

function createComposition() {
  const auditDeps = { audit: Db.auditRepo };
  const userDeps = { users: Db.userRepo };
  const txRunner = Db.transactionRunner;

  return {
    ingestFile: (input: Parameters<typeof ingestFile>[0]) => bind(ingestFile, input, ingestDeps),
    searchChunks: (q: string, o: Parameters<typeof searchChunks>[1]) => bind(searchChunks, q, o, searchDeps),
    /** Session 8 agentic retrieval loop (rewrite → retrieve → grade → retry).
      * Returns `null` when AGENTIC_ENABLED=false so the route falls back to the
      * plain `searchChunks` path. */
    agenticSearch: agenticDeps
      ? (query: string) => agenticSearch(query, agenticDeps)
      : null,
    /** Session 8 hallucination grader (post-generation guardrail). `null` when
      * AGENTIC_ENABLED=false. */
    hallucinationGrader: agenticDeps ? agenticDeps.hallucinationGrader.grade : null,
    listUsers: (input: Parameters<typeof listUsers>[0]) => bind(listUsers, input, userDeps),
    setUserRole: (input: Parameters<typeof setUserRole>[0]) => bind(setUserRole, input, { ...userDeps, ...auditDeps }),
    touchLastSeen: (id: string) => bind(touchLastSeen, id, userDeps),
    getUserByClerkId: (id: string) => bind(getUserByClerkId, id, userDeps),
    logDocumentEvent: (input: Parameters<typeof logDocumentEvent>[0]) => bind(logDocumentEvent, input, auditDeps),
    logTicketEvent: (input: Parameters<typeof logTicketEvent>[0]) => bind(logTicketEvent, input, auditDeps),
    recordQuery: (userId: string, query: string) => recordQuery(userId, query, { stats: createQueryStats() }),
    getTopQueries: (limit: number) => getTopQueries(limit, { stats: createQueryStats() }),
    enforceRateLimit: (input: Parameters<typeof enforceRateLimit>[0]) => bind(enforceRateLimit, input, rateLimitDeps),
    listDocuments: (input: Parameters<typeof listDocuments>[0]) =>
      bind(listDocuments, input, { documents: documentRepo, chunks: chunkRepo, ...userDeps }),
    uploadPdf: (input: Parameters<typeof uploadPdf>[0]) =>
      bind(uploadPdf, input, { ...ingestDeps, ...auditDeps, runner: txRunner, blobStorage, ingestQueue }),
    softDeleteDocument: (input: Parameters<typeof softDeleteDocument>[0]) =>
      bind(softDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner }),
    restoreDocument: (id: number, actorId: string) =>
      bind(restoreDocument, id, actorId, { documents: documentRepo, ...auditDeps, clock: systemClock, runner: txRunner }),
    listTickets: (input: Parameters<typeof listTickets>[0]) => bind(listTickets, input, { tickets: Db.ticketRepo }),
    updateTicket: (input: Parameters<typeof updateTicket>[0]) =>
      bind(updateTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    createTicket: (input: Parameters<typeof createTicket>[0]) =>
      bind(createTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    getDocumentById: (id: number, opts?: { includeDeleted?: boolean }) => getDocumentById(id, { documents: documentRepo }, opts),
    hardDeleteDocument: (input: { documentId: number; actorId: string }) =>
      bind(hardDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, blobStorage }),
    replacePdf: (input: { documentId: number; fileName: string; buffer: Buffer; actorId: string }) =>
      bind(replacePdf, input, { ...ingestDeps, ...auditDeps, runner: txRunner, blobStorage, ingestQueue }),
    /** Ingest pre-chunked Markdown (Session 2). Parses via the injected
      * MarkdownParser adapter (infrastructure), then embeds + writes the
      * chunks with their page/section/source metadata. An optional companion
      * PDF is stored as the document blob for preview/download. */
    uploadChunkedMarkdown: (input: {
      fileName: string;
      mdText: string;
      delimiter?: string;
      uploadedBy: string;
      pdfBuffer?: Buffer;
      pdfFileName?: string;
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
      }),
    /** Drain a queued ingest: called by the /api/admin/ingest-worker
     *  route on a QStash callback. Loads the doc, reads the PDF from the blob
     *  store, parses+embeds it, then claims the job and inserts chunks + flips
     *  to `done` inside one transaction. A retry that sees `done` is a no-op; a
     *  concurrent worker that already claimed the job returns `busy` (the route
     *  maps that to 409 so QStash retries later).
     *  The claim is now atomic via `DocumentRepository.claimIngest`
     *  (`UPDATE … WHERE ingest_status='queued' RETURNING`), so concurrent
     *  deliveries cannot both embed/insert (M1).
     *  NOTE: a crash after a successful claim leaves the doc stuck in
     *  `ingesting`; there is no auto-recovery scan — a future job should
     *  periodically re-queue (or time-out) stuck `ingesting` rows. */
    ingestQueuedDocument: async (documentId: number): Promise<Result<{ status: 'done' | 'already-done' | 'busy'; chunks: number }>> => {
      const doc = await documentRepo.findById(documentId);
      if (!doc) return err(new NotFoundError(`Document not found: ${documentId}`));
      if (doc.ingestStatus === 'done') return ok({ status: 'already-done', chunks: 0 });
      if (doc.ingestStatus === 'ingesting') return ok({ status: 'busy', chunks: 0 });
      if (!doc.storageKey) {
        return err(new NotFoundError(`Document ${documentId} has no stored blob`));
      }
      let buffer: Buffer;
      try {
        buffer = await blobStorage.get(doc.storageKey);
      } catch (e) {
        await documentRepo.updateIngestStatus(documentId, 'failed').catch(() => {});
        return err(new ExternalServiceError('Blob read failed', e));
      }
      const prepared = await prepareIngest(
        { documentId, fileName: doc.fileName, buffer },
        ingestDeps,
      );
      if (!prepared.ok) {
        await documentRepo.updateIngestStatus(documentId, 'failed').catch(() => {});
        return prepared;
      }
      try {
        const outcome = await Db.transactionRunner.run(async (tx) => {
          // Atomic conditional claim: only the caller that flips
          // queued→ingesting wins; a concurrent/replayed worker gets false.
          const claimed = await tx.documents.claimIngest(documentId);
          if (!claimed) return { claimed: false } as const;
          await tx.chunks.insertMany(prepared.value.rows);
          await tx.documents.updateIngestStatus(documentId, 'done');
          return { claimed: true, chunks: prepared.value.chunks } as const;
        });
        if (!outcome.claimed) return ok({ status: 'busy', chunks: 0 });
        return ok({ status: 'done', chunks: outcome.chunks });
      } catch (e) {
        await documentRepo.updateIngestStatus(documentId, 'failed').catch(() => {});
        return err(new ExternalServiceError('Chunk insert failed', e));
      }
    },
    recountChunksForDocument: (id: number) => bind(recountChunksForDocument, id, { chunks: chunkRepo }),
    recountChunksForAllDocuments: () => bind(recountChunksForAllDocuments, { chunks: chunkRepo }),
    reingestAll: () => reingestAll({ documents: documentRepo, queue: ingestQueue }),
    getAnalyticsSummary: () =>
      bind(getAnalyticsSummary, { documents: documentRepo, chunks: chunkRepo, tickets: Db.ticketRepo, ...userDeps, stats: createQueryStats() }),
    listAudit: (input: Parameters<typeof listAudit>[0]) => bind(listAudit, input, auditDeps),
    db: Db.db,
    schema: Db.schema,
    blobStorage,
    getEmbeddingModel: Llm.getEmbeddingModel,
    getChatModel: Llm.getChatModel,
    getEmbeddingModelId: Llm.getEmbeddingModelId,
    answerCacheKey,
    answerCache: createAnswerCache(),
    session: Auth.clerkSessionStore,
    rateLimit: async (key: string, opts: { limit: number; windowMs: number }) =>
      createRateLimiter().check(key, opts),
  };
}

export { appConfig, isTicketStatus, TICKET_STATUSES, type MyUIMessage };
export { requireAdmin, requireSession, getAppSession, ForbiddenError, unwrap };
export { respond, respondResult };


export type Composition = ReturnType<typeof createComposition>;

let _composition: Composition | null = null;
export function getComposition(): Composition {
  if (!_composition) _composition = createComposition();
  return _composition;
}

export async function requireAdminRoute(): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof requireAdmin>>; comp: Composition }
  | { ok: false; response: Response }
> {
  try {
    const session = await requireAdmin();
    return { ok: true, session, comp: getComposition() };
  } catch (err) {
    if (err instanceof UnauthorizedError) return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    if (err instanceof ForbiddenError) return { ok: false, response: new Response('Forbidden', { status: 403 }) };
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

/** Parse a `page` search-param into a 1-based integer, falling
 *  back gracefully on NaN, negatives, or floats. */
export function parsePageParam(raw: string | undefined, fallback = 1): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export async function requireAdminGet(
  req: Request,
): Promise<
  | { ok: true; comp: Composition; url: URL }
  | { ok: false; response: Response }
> {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth;
  return { ok: true, comp: auth.comp, url: new URL(req.url) };
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
