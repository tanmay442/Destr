import { requireAdminGet, parseQueryPagination, respondResult, respond } from '@/composition';
import { ValidationError } from '@app/domain';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const { comp, url } = auth;
  const documentIdRaw = url.searchParams.get('documentId');
  const ticketId = url.searchParams.get('ticketId');
  let documentId: number | undefined;
  if (documentIdRaw !== null) {
    const n = Number(documentIdRaw);
    if (!Number.isInteger(n)) return respond(new ValidationError('Invalid documentId'));
    documentId = n;
  }
  let ticketIdFilter: string | undefined;
  if (ticketId !== null) {
    if (!/^[\w-]{1,255}$/.test(ticketId)) {
      return respond(new ValidationError('Invalid ticketId'));
    }
    ticketIdFilter = ticketId;
  }
  const { limit, offset } = parseQueryPagination(url, { limit: 50 });
  const result = await comp.listAudit({
    documentId,
    ticketId: ticketIdFilter,
    limit,
    offset,
  });
  return respondResult(result);
}
