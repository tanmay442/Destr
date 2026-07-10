import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getComposition, unwrap } from '@/composition';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isInteger(docId)) notFound();
  const r = unwrap(await getComposition().getDocumentById(docId));
  const doc = r.document;
  if (!doc) notFound();
  if (doc.deletedAt) {
    return (
      <section className="flex flex-col gap-3" data-testid="document-preview">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-medium">{doc.fileName}</h2>
            <p className="text-xs text-foreground-muted">This document has been deleted. Restore it to preview.</p>
          </div>
          <Link
            href="/admin/documents"
            className="rounded border border-border bg-surface/40 px-3 py-1 text-sm text-foreground transition-colors duration-150 hover:bg-surface-elevated"
          >
            Back
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3" data-testid="document-preview">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium">{doc.fileName}</h2>
          <p className="text-xs text-foreground-muted">
            {doc.storageKey
              ? 'PDF stored in object storage'
              : 'Preview unavailable (no stored file)'}
          </p>
        </div>
        <Link
          href="/admin/documents"
          className="rounded border border-border bg-surface/40 px-3 py-1 text-sm text-foreground transition-colors duration-150 hover:bg-surface-elevated"
        >
          Back
        </Link>
      </div>
      {doc.storageKey ? (
        <iframe
          src={`/api/admin/documents/${docId}/blob#toolbar=0`}
          className="h-[80vh] w-full rounded border border-border"
          title={`Preview ${doc.fileName}`}
          data-testid="document-iframe"
        />
      ) : (
        <div className="rounded border border-dashed border-border p-6 text-center text-sm text-foreground-muted">
          Preview unavailable.
        </div>
      )}
    </section>
  );
}
