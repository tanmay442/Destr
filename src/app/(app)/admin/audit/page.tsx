import { getComposition, getAppSession, unwrap, parsePageParam } from '@/composition';
import type { AuditKind } from '@app/domain';
import { Pagination } from '@/components/admin/Pagination';
import { AUDIT_PAGE_SIZE, ADMIN_KINDS } from '@/components/admin/admin-helpers';
import { AuditLogTable } from '@/components/admin/AuditLogTable';
import { AuditFilterForm } from './audit-filter-form';

export const dynamic = 'force-dynamic';

function parseKind(raw: string | undefined): AuditKind | undefined {
  return (ADMIN_KINDS as readonly string[]).includes(raw ?? '') ? (raw as AuditKind) : undefined;
}

function parseDate(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    documentId?: string;
    ticketId?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const page = parsePageParam(params.page);
  const offset = (page - 1) * AUDIT_PAGE_SIZE;
  const documentIdRaw = params.documentId ? Number(params.documentId) : undefined;
  const documentId = Number.isInteger(documentIdRaw) ? documentIdRaw : undefined;
  const kind = parseKind(params.kind);
  const action = params.action || undefined;
  const actor = params.actor || undefined;
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const result = unwrap(await getComposition().listAudit({
    kind,
    action,
    actor,
    from: parseDate(params.from),
    to: parseDate(params.to, true),
    documentId,
    ticketId: params.ticketId,
    limit: AUDIT_PAGE_SIZE,
    offset,
    actorId,
  }));
  const totalPages = Math.max(1, Math.ceil(result.total / AUDIT_PAGE_SIZE));
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Audit log</h2>
        <p className="text-sm text-muted-foreground">
          Recent admin and system actions. Filter by kind, actor, or date.
        </p>
      </div>
      <AuditFilterForm
        kind={kind}
        action={action}
        actor={actor}
        from={params.from}
        to={params.to}
      />
      <AuditLogTable events={result.events} />
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/audit"
        query={{
          kind,
          action,
          actor,
          from: params.from,
          to: params.to,
          documentId,
          ticketId: params.ticketId,
        }}
      />
    </section>
  );
}
