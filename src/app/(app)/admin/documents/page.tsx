import { getComposition, getAppSession, unwrap, parsePageParam } from '@/composition';
import { DocumentRowActions } from './document-row-actions';
import { RecountAllButton } from './recount-all-button';
import { IngestStatusPoller } from './ingest-status-poller';
import { Pagination } from '@/components/admin/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import type { IngestStatus } from '@app/domain';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function ingestBadgeClass(status: IngestStatus): string {
  switch (status) {
    case 'queued':
      return 'rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning';
    case 'ingesting':
      return 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary';
    case 'failed':
      return 'rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive';
    case 'done':
    default:
      return 'rounded-full border border-muted-foreground/30 px-2 py-0.5 text-xs text-muted-foreground';
  }
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    page?: string;
    recountedDocs?: string;
    recountedTotal?: string;
  }>;
}) {
  const params = await searchParams;
  const search = params.search?.trim() ?? '';
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const recountedDocsRaw = params.recountedDocs;
  const recountedTotalRaw = params.recountedTotal;
  const recountedDocs =
    recountedDocsRaw !== undefined && recountedDocsRaw !== ''
      ? Number(recountedDocsRaw)
      : null;
  const recountedTotal =
    recountedTotalRaw !== undefined && recountedTotalRaw !== ''
      ? Number(recountedTotalRaw)
      : null;
  const showRecountBanner =
    recountedDocs !== null &&
    !Number.isNaN(recountedDocs) &&
    recountedTotal !== null &&
    !Number.isNaN(recountedTotal);
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const result = unwrap(await getComposition().listDocuments({
    search: search || undefined,
    includeDeleted: true,
    limit: PAGE_SIZE,
    offset,
    actorId,
  }));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const hasPendingIngest = result.documents.some(
    (d) => d.ingestStatus === 'queued' || d.ingestStatus === 'ingesting',
  );
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-medium">Documents</h2>
      <div className="flex flex-col gap-2">
        <form className="flex gap-2" method="get" aria-label="Search documents">
          <Label className="sr-only" htmlFor="documents-search">
            Search documents
          </Label>
          <Input
            id="documents-search"
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Search file name…"
            className="flex-1 bg-background"
            data-testid="documents-search"
          />
          <Button type="submit">Search</Button>
          <RecountAllButton />
        </form>
        {showRecountBanner ? (
          <Alert
            className="border-success/40 bg-success/10 px-3 py-2 text-success"
            data-testid="documents-recount-banner"
            role="status"
          >
            Recounted {recountedDocs} document{recountedDocs === 1 ? '' : 's'}, total {recountedTotal} chunk{recountedTotal === 1 ? '' : 's'}.
          </Alert>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <Table data-testid="documents-table" aria-label="Documents">
          <TableHeader className="bg-secondary text-muted-foreground">
            <TableRow>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                File
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Uploaded by
              </TableHead>
              <TableHead className="px-3 py-2 text-right text-xs uppercase">
                At
              </TableHead>
              <TableHead className="px-3 py-2 text-right text-xs uppercase">
                Chunks
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Status
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Ingest
              </TableHead>
              <TableHead className="px-3 py-2 text-left text-xs uppercase">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.documents.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No documents.
                </TableCell>
              </TableRow>
            ) : (
              result.documents.map((d) => (
                <TableRow
                  key={d.id}
                  className="border-border-subtle hover:bg-secondary/40"
                  data-testid={`documents-row-${d.id}`}
                >
                  <TableCell className="px-3 py-2 font-medium text-foreground">
                    {d.fileName}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-muted-foreground">
                    {d.uploaderName ?? d.uploadedBy}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground">
                    {d.uploadedAt.toISOString()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right text-foreground">
                    {d.chunkCount}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    {d.deletedAt ? (
                      <Badge className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                        deleted
                      </Badge>
                    ) : (
                      <Badge className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success">
                        live
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      className={ingestBadgeClass(d.ingestStatus)}
                      data-testid={`documents-ingest-status-${d.id}`}
                    >
                      {d.ingestStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <DocumentRowActions
                      id={d.id}
                      fileName={d.fileName}
                      hasBlob={d.hasBlob}
                      isDeleted={d.deletedAt != null}
                    />
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
        pathname="/admin/documents"
        query={{ search }}
      />
      <IngestStatusPoller hasPending={hasPendingIngest} />
    </section>
  );
}
