import { getComposition, unwrap, parsePageParam } from '@/composition';
import { Pagination } from '@/components/admin/Pagination';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ documentId?: string; ticketId?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const documentIdRaw = params.documentId ? Number(params.documentId) : undefined;
  const documentId = Number.isFinite(documentIdRaw) ? documentIdRaw : undefined;
  const ticketId = params.ticketId;
  const result = unwrap(await getComposition().listAudit({
    documentId,
    ticketId,
    limit: PAGE_SIZE,
    offset,
  }));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">Audit log</h2>
      <form className="flex flex-wrap gap-2" method="get" aria-label="Filter audit log">
        <label className="sr-only" htmlFor="audit-documentId">
          Document id
        </label>
        <input
          id="audit-documentId"
          type="number"
          name="documentId"
          defaultValue={documentId ?? ''}
          placeholder="Document id"
          className="w-32 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-subtle"
        />
        <label className="sr-only" htmlFor="audit-ticketId">
          Ticket id
        </label>
        <input
          id="audit-ticketId"
          type="text"
          name="ticketId"
          defaultValue={ticketId ?? ''}
          placeholder="Ticket id (TKT-1001)"
          className="w-48 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-subtle"
        />
        <button
          type="submit"
          className="rounded-xl bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          Filter
        </button>
      </form>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm" data-testid="audit-table" aria-label="Audit events">
          <thead className="bg-surface-elevated text-left text-xs uppercase text-foreground-muted">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Actor</th>
            </tr>
          </thead>
          <tbody>
            {result.events.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-4 text-center text-foreground-muted"
                >
                  No audit events.
                </td>
              </tr>
            ) : (
              result.events.map((e) => (
                <tr
                  key={`${e.kind}-${e.id}`}
                  className="border-t border-border-subtle hover:bg-surface-elevated/40"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-foreground-muted">
                    {e.at.toISOString()}
                  </td>
                  <td className="px-3 py-2 text-xs text-foreground">
                    {e.kind}
                  </td>
                  <td className="px-3 py-2 text-xs font-medium text-foreground">
                    {e.action}
                  </td>
                  <td className="px-3 py-2 text-xs text-foreground-muted">
                    {e.kind === 'document'
                      ? `document #${e.documentId}`
                      : e.ticketId}
                  </td>
                  <td className="px-3 py-2 text-xs text-foreground-muted">
                    {e.actorName ?? e.actorId}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/audit"
        query={{ documentId, ticketId }}
      />
    </section>
  );
}
