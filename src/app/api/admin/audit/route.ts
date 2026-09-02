import { requireAdminGet, parseQueryPagination, respondResult, respond } from '@/composition';
import { ValidationError, type AuditKind } from '@app/domain';

const AUDIT_KINDS: readonly AuditKind[] = ['document', 'ticket', 'user', 'settings'];

const MAX_AUDIT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function parseDate(raw: string | null, label: string): { ok: true; value?: Date } | { ok: false; error: Response } {
  if (raw === null) return { ok: true };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: respond(new ValidationError(`Invalid ${label}`)) };
  return { ok: true, value: d };
}

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
  const kindRaw = url.searchParams.get('kind');
  let kind: AuditKind | undefined;
  if (kindRaw !== null) {
    if (!(AUDIT_KINDS as readonly string[]).includes(kindRaw)) {
      return respond(new ValidationError('Invalid kind'));
    }
    kind = kindRaw as AuditKind;
  }
  const from = parseDate(url.searchParams.get('from'), 'from');
  if (!from.ok) return from.error;
  const to = parseDate(url.searchParams.get('to'), 'to');
  if (!to.ok) return to.error;
  if (from.value && to.value && from.value.getTime() > to.value.getTime()) {
    return respond(new ValidationError('Invalid date range'));
  }
  if (from.value && to.value && to.value.getTime() - from.value.getTime() > MAX_AUDIT_RANGE_MS) {
    return respond(new ValidationError('Date range too large'));
  }
  const { limit, offset } = parseQueryPagination(url, { limit: 50 });
  const cursor = url.searchParams.get('cursor');
  const before = url.searchParams.get('before');
  const result = await comp.listAudit({
    kind,
    action: url.searchParams.get('action')?.slice(0, 200) ?? undefined,
    actor: url.searchParams.get('actor')?.slice(0, 200) ?? undefined,
    from: from.value,
    to: to.value,
    documentId,
    ticketId: ticketIdFilter,
    limit,
    ...(cursor !== null ? { cursor } : {}),
    ...(before !== null ? { before } : {}),
    ...(cursor === null && before === null ? { offset } : {}),
    actorId: auth.session.user.id,
  });
  return respondResult(result);
}
