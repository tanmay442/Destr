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
  type IngestDeps, type SearchDeps, type RateLimitDeps,
} from '@app/application';
import { Db, Llm, Auth, Pdf, Storage } from '@app/infrastructure';
import { requireAdmin, requireSession, getAppSession } from '@app/infrastructure/auth';
import { ForbiddenError, UnauthorizedError, unwrap, type Result, type BlobStorage } from '@app/domain';
import { type MyUIMessage } from '@app/application/chat';
import type { DocumentRow } from '@app/domain';
import { createHash } from 'node:crypto';
import { appConfig } from './lib/config';
import { logger } from './lib/logger';
import { respond, respondResult, toActionResult, isActionError } from './lib/http';
import { MAX_LIST_LIMIT } from '../config/constants';

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

const ingestDeps: IngestDeps = {
  documents: documentRepo, chunks: chunkRepo,
  embeddings: embeddingService, hasher: systemHasher,
  pdfParser: Pdf.pdfParseParser, textSplitter: Pdf.langchainSplitter,
};
const searchDeps: SearchDeps = { chunks: chunkRepo, embeddings: embeddingService };
const rateLimitDeps: RateLimitDeps = { limiter: Auth.lruRateLimiter };

function createComposition() {
  const auditDeps = { audit: Db.auditRepo };
  const userDeps = { users: Db.userRepo };
  const txRunner = Db.transactionRunner;

  return {
    ingestFile: (input: Parameters<typeof ingestFile>[0]) => bind(ingestFile, input, ingestDeps),
    searchChunks: (q: string, o: Parameters<typeof searchChunks>[1]) => bind(searchChunks, q, o, searchDeps),
    listUsers: (input: Parameters<typeof listUsers>[0]) => bind(listUsers, input, userDeps),
    setUserRole: (input: Parameters<typeof setUserRole>[0]) => bind(setUserRole, input, { ...userDeps, ...auditDeps }),
    touchLastSeen: (id: string) => bind(touchLastSeen, id, userDeps),
    getUserByClerkId: (id: string) => bind(getUserByClerkId, id, userDeps),
    logDocumentEvent: (input: Parameters<typeof logDocumentEvent>[0]) => bind(logDocumentEvent, input, auditDeps),
    logTicketEvent: (input: Parameters<typeof logTicketEvent>[0]) => bind(logTicketEvent, input, auditDeps),
    recordQuery: (userId: string, query: string) => recordQuery(userId, query, { stats: Auth.inMemoryQueryStats }),
    getTopQueries: (limit: number) => getTopQueries(limit, { stats: Auth.inMemoryQueryStats }),
    enforceRateLimit: (input: Parameters<typeof enforceRateLimit>[0]) => bind(enforceRateLimit, input, rateLimitDeps),
    listDocuments: (input: Parameters<typeof listDocuments>[0]) =>
      bind(listDocuments, input, { documents: documentRepo, chunks: chunkRepo, ...userDeps }),
    uploadPdf: (input: Parameters<typeof uploadPdf>[0]) =>
      bind(uploadPdf, input, { ...ingestDeps, ...auditDeps, runner: txRunner, blobStorage }),
    softDeleteDocument: (input: Parameters<typeof softDeleteDocument>[0]) =>
      bind(softDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner }),
    restoreDocument: (id: number, actorId: string) =>
      bind(restoreDocument, id, actorId, { documents: documentRepo, ...auditDeps, clock: systemClock, runner: txRunner }),
    listTickets: (input: Parameters<typeof listTickets>[0]) => bind(listTickets, input, { tickets: Db.ticketRepo }),
    updateTicket: (input: Parameters<typeof updateTicket>[0]) =>
      bind(updateTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    createTicket: (input: Parameters<typeof createTicket>[0]) =>
      bind(createTicket, input, { tickets: Db.ticketRepo, ...auditDeps }),
    getDocumentById: (id: number) => getDocumentById(id, { documents: documentRepo }),
    hardDeleteDocument: (input: { documentId: number; actorId: string }) =>
      bind(hardDeleteDocument, input, { documents: documentRepo, ...auditDeps, runner: txRunner, blobStorage }),
    replacePdf: (input: { documentId: number; fileName: string; buffer: Buffer; actorId: string }) =>
      bind(replacePdf, input, { ...ingestDeps, ...auditDeps, runner: txRunner, blobStorage }),
    recountChunksForDocument: (id: number) => bind(recountChunksForDocument, id, { chunks: chunkRepo }),
    recountChunksForAllDocuments: () => bind(recountChunksForAllDocuments, { chunks: chunkRepo }),
    getAnalyticsSummary: () =>
      bind(getAnalyticsSummary, { documents: documentRepo, chunks: chunkRepo, tickets: Db.ticketRepo, ...userDeps, stats: Auth.inMemoryQueryStats }),
    listAudit: (input: Parameters<typeof listAudit>[0]) => bind(listAudit, input, auditDeps),
    db: Db.db,
    schema: Db.schema,
    blobStorage,
    getEmbeddingModel: Llm.getEmbeddingModel,
    getChatModel: Llm.getChatModel,
    session: Auth.clerkSessionStore,
    rateLimit: (key: string, opts: { limit: number; windowMs: number }) =>
      Auth.lruRateLimiter.check(key, opts),
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

function resetComposition() {
  _composition = null;
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
  const r = await auth.comp.getDocumentById(docId);
  if (!r.ok) return { ok: false, response: respond(r.error) };
  const doc = r.value.document;
  if (!doc) return { ok: false, response: new Response('Not found', { status: 404 }) };
  if (!opts.allowDeleted && doc.deletedAt) return { ok: false, response: new Response('Gone', { status: 410 }) };
  if (!doc.storageKey) return { ok: false, response: new Response('File unavailable', { status: 404 }) };
  return { ok: true, session: auth.session, comp: auth.comp, document: doc };
}
