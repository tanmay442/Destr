import { requireAdminGet, respondResult, respond } from '@/composition';
import { ValidationError } from '@app/domain';

const MAX_LIST_LIMIT = 100;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const rawLimit = Number(auth.url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIST_LIMIT) : undefined;
  const from = parseDate(auth.url.searchParams.get('from'));
  const to = parseDate(auth.url.searchParams.get('to'));
  if (from && to && from.getTime() > to.getTime()) {
    return respond(new ValidationError('Invalid date range'));
  }
  if (from && to && to.getTime() - from.getTime() > MAX_RANGE_MS) {
    return respond(new ValidationError('Date range too large'));
  }
  const range = from || to ? { from, to } : undefined;
  const result = await auth.comp.getDocumentAnalytics({ actorId: auth.session.user.id, range, limit });
  return respondResult(result);
}
