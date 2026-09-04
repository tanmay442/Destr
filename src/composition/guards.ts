import type { DocumentRow } from '@app/domain';
import { ForbiddenError, UnauthorizedError } from '@app/domain';
import { respond } from '../lib/http';
import { MAX_LEGACY_LIST_OFFSET, MAX_LIST_LIMIT } from '@app/domain';
import { logger } from '../lib/logger';
import { requireAdmin } from './infra';
import { getComposition } from './startup';
import type { Composition } from './factory';

export function assertSameOrigin(req: Request): Response | null {
  const origin = req.headers.get('origin');
  if (!origin) {
    const secFetch = req.headers.get('sec-fetch-site');
    if (secFetch && secFetch !== 'same-origin' && secFetch !== 'same-site')
      return new Response('CSRF', { status: 403 });
    return null;
  }
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
    offset: Math.min(
      Math.max(Math.floor(Number.isFinite(rawOffset) ? rawOffset : (defaults.offset ?? 0)), 0),
      MAX_LEGACY_LIST_OFFSET,
    ),
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
