import Link from 'next/link';
import { getComposition, unwrap, parsePageParam } from '@/composition';
import { DocumentRowActions } from './document-row-actions';
import { RecountAllButton } from './recount-all-button';
import { IngestStatusPoller } from './ingest-status-poller';
import { Pagination } from '@/components/admin/Pagination';
import type { IngestStatus } from '@app/domain';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function ingestBadgeClass(status: IngestStatus): string {
  switch (status) {
    case 'queued':
      return 'rounded-full border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--warning)]';
    case 'ingesting':
      return 'rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]';
    case 'failed':
      return 'rounded-full border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-2 py-0.5 text-xs text-[var(--danger)]';
    case 'done':
    default:
      return 'rounded-full border border-[var(--foreground-muted)]/30 px-2 py-0.5 text-xs text-[var(--foreground-muted)]';
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
  // Read the success-banner params (set by RecountAllButton) so the
  // message survives the page reload triggered by revalidatePath.
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
  const result = unwrap(await getComposition().listDocuments({
    search: search || undefined,
    includeDeleted: true,
    limit: PAGE_SIZE,
    offset,
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
          <label className="sr-only" htmlFor="documents-search">
            Search documents
          </label>
          <input
            id="documents-search"
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Search file name…"
            className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-subtle)]"
            data-testid="documents-search"
          />
          <button
            type="submit"
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Search
          </button>
          <RecountAllButton />
        </form>
        {showRecountBanner ? (
          <div
            className="rounded-xl border border-[var(--success)]/40 bg-[var(--success)]/10 px-3 py-2 text-sm text-[var(--success)]"
            data-testid="documents-recount-banner"
            role="status"
          >
            Recounted {recountedDocs} document{recountedDocs === 1 ? '' : 's'}, total {recountedTotal} chunk{recountedTotal === 1 ? '' : 's'}.
          </div>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm" data-testid="documents-table" aria-label="Documents">
          <thead className="bg-[var(--surface-elevated)] text-left text-xs uppercase text-[var(--foreground-muted)]">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Uploaded by</th>
              <th className="px-3 py-2 text-right">At</th>
              <th className="px-3 py-2 text-right">Chunks</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Ingest</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {result.documents.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-4 text-center text-[var(--foreground-muted)]"
                >
                  No documents.
                </td>
              </tr>
            ) : (
              result.documents.map((d) => (
                <tr
                  key={d.id}
                  className="border-t border-[var(--border-subtle)] hover:bg-[var(--surface-elevated)]/40"
                  data-testid={`documents-row-${d.id}`}
                >
                  <td className="px-3 py-2 font-medium text-[var(--foreground)]">
                    {d.fileName}
                  </td>
                  <td className="px-3 py-2 text-[var(--foreground-muted)]">
                    {d.uploaderName ?? d.uploadedBy}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-[var(--foreground-muted)]">
                    {d.uploadedAt.toISOString()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-[var(--foreground)]">
                    {d.chunkCount}
                  </td>
                  <td className="px-3 py-2">
                    {d.deletedAt ? (
                      <span className="rounded-full border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-2 py-0.5 text-xs text-[var(--danger)]">
                        deleted
                      </span>
                    ) : (
                      <span className="rounded-full border border-[var(--success)]/40 bg-[var(--success)]/10 px-2 py-0.5 text-xs text-[var(--success)]">
                        live
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={ingestBadgeClass(d.ingestStatus)}
                      data-testid={`documents-ingest-status-${d.id}`}
                    >
                      {d.ingestStatus}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <DocumentRowActions
                      id={d.id}
                      fileName={d.fileName}
                      hasBlob={d.hasBlob}
                      isDeleted={d.deletedAt != null}
                    />
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
        pathname="/admin/documents"
        query={{ search }}
      />
      <IngestStatusPoller hasPending={hasPendingIngest} />
    </section>
  );
}
