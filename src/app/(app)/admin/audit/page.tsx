import { getComposition, unwrap, parsePageParam } from '@/composition';
import { Pagination } from '@/components/admin/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

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
  const documentId = Number.isInteger(documentIdRaw) ? documentIdRaw : undefined;
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
        <Label className="sr-only" htmlFor="audit-documentId">
          Document id
        </Label>
        <Input
          id="audit-documentId"
          type="number"
          name="documentId"
          defaultValue={documentId ?? ''}
          placeholder="Document id"
          className="w-32 bg-background"
        />
        <Label className="sr-only" htmlFor="audit-ticketId">
          Ticket id
        </Label>
        <Input
          id="audit-ticketId"
          type="text"
          name="ticketId"
          defaultValue={ticketId ?? ''}
          placeholder="Ticket id (TKT-1001)"
          className="w-48 bg-background"
        />
        <Button type="submit">Filter</Button>
      </form>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <Table data-testid="audit-table" aria-label="Audit events">
          <TableHeader className="bg-secondary text-muted-foreground">
            <TableRow>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                When
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Kind
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Action
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Target
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Actor
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.events.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No audit events.
                </TableCell>
              </TableRow>
            ) : (
              result.events.map((e) => (
                <TableRow
                  key={`${e.kind}-${e.id}`}
                  className="border-border-subtle hover:bg-secondary/40"
                >
                  <TableCell className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {e.at.toISOString()}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-foreground">
                    {e.kind}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs font-medium text-foreground">
                    {e.action}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {e.kind === 'document'
                      ? `document #${e.documentId}`
                      : e.ticketId}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {e.actorName ?? e.actorId}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
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
