import { getComposition, getAppSession, unwrap, parsePageParam } from '@/composition';
import { DocumentRowActions } from './document-row-actions';
import { RecountAllButton } from './recount-all-button';
import { UploadDocumentDialog } from './upload-document-dialog';
import { IngestStatusPoller } from './ingest-status-poller';
import { Pagination } from '@/components/admin/Pagination';
import { TableShell, TableEmptyRow } from '@/components/admin/TableShell';
import { PAGE_SIZE } from '@/components/admin/admin-helpers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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

function ingestBadgeClass(status: IngestStatus): string {
  switch (status) {
    case 'queued':
      return 'border-warning/40 bg-warning/10 text-warning';
    case 'ingesting':
      return 'border-primary/40 bg-primary/10 text-primary';
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'done':
    default:
      return 'border-border text-muted-foreground';
  }
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const search = params.search?.trim() ?? '';
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
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
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Documents</h2>
        <p className="text-sm text-muted-foreground">
          Manage uploaded PDFs and their ingestion status.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <form
            className="flex flex-col gap-2 sm:flex-1 sm:flex-row sm:items-center"
            method="get"
            aria-label="Search documents"
          >
            <Label className="sr-only" htmlFor="documents-search">
              Search documents
            </Label>
            <Input
              id="documents-search"
              type="search"
              name="search"
              defaultValue={search}
              placeholder="Search file name…"
              className="sm:flex-1"
              data-testid="documents-search"
            />
            <Button type="submit" size="sm" className="w-fit">
              Search
            </Button>
          </form>
          <div className="flex items-center gap-2">
            <RecountAllButton />
            <UploadDocumentDialog />
          </div>
        </div>
      </div>

      <TableShell>
        <Table data-testid="documents-table" aria-label="Documents">
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead className="hidden md:table-cell">Uploaded by</TableHead>
              <TableHead className="hidden text-right lg:table-cell">At</TableHead>
              <TableHead className="text-right">Chunks</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ingest</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.documents.length === 0 ? (
              <TableEmptyRow colSpan={7}>No documents.</TableEmptyRow>
            ) : (
              result.documents.map((d) => (
                <TableRow
                  key={d.id}
                  data-testid={`documents-row-${d.id}`}
                >
                  <TableCell className="max-w-[260px] font-medium text-foreground">
                    <div className="flex flex-col">
                      <span className="truncate" title={d.fileName}>
                        {d.fileName}
                      </span>
                      <span className="text-xs text-muted-foreground md:hidden">
                        {d.uploaderName ?? d.uploadedBy}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {d.uploaderName ?? d.uploadedBy}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:table-cell">
                    <time dateTime={d.uploadedAt.toISOString()} title={d.uploadedAt.toISOString()}>
                      {d.uploadedAt.toISOString().slice(0, 10)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap text-foreground tabular-nums">
                    {d.chunkCount.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {d.deletedAt ? (
                      <Badge variant="outline" className="border-destructive/40 text-destructive">
                        deleted
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-success/40 text-success">
                        live
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={ingestBadgeClass(d.ingestStatus)}
                      data-testid={`documents-ingest-status-${d.id}`}
                    >
                      {d.ingestStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
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
      </TableShell>
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
