import { requireAdminGet, parseQueryPagination, respondResult, respond } from '@/composition';
import { ValidationError, type AuditKind } from '@app/domain';

const AUDIT_KINDS: readonly AuditKind[] = ['document', 'ticket', 'user', 'settings'];

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
  const { limit, offset } = parseQueryPagination(url, { limit: 50 });
  const result = await comp.listAudit({
    kind,
    action: url.searchParams.get('action') ?? undefined,
    actor: url.searchParams.get('actor') ?? undefined,
    from: from.value,
    to: to.value,
    documentId,
    ticketId: ticketIdFilter,
    limit,
    offset,
    actorId: auth.session.user.id,
  });
  return respondResult(result);
}
