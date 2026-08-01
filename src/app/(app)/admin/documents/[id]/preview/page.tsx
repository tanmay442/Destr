import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileWarning } from 'lucide-react';
import { getComposition, unwrap } from '@/composition';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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
      <section className="flex flex-col gap-4" data-testid="document-preview">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {doc.fileName}
            </h2>
            <p className="text-sm text-muted-foreground">
              This document has been deleted. Restore it to preview.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/documents">
              <ArrowLeft data-icon="inline-start" />
              Back
            </Link>
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4" data-testid="document-preview">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {doc.fileName}
          </h2>
          <p className="text-sm text-muted-foreground">
            {doc.storageKey
              ? 'PDF stored in object storage'
              : 'Preview unavailable (no stored file)'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/documents">
              <ArrowLeft data-icon="inline-start" />
              Back
            </Link>
          </Button>
        </div>
      </div>
      {doc.storageKey ? (
        <Card className="overflow-hidden p-0 shadow-none">
          <iframe
            src={`/api/admin/documents/${docId}/blob#toolbar=0`}
            className="h-[80vh] w-full"
            title={`Preview ${doc.fileName}`}
            data-testid="document-iframe"
          />
        </Card>
      ) : (
        <Card className="border-dashed p-8 shadow-none">
          <CardContent className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <FileWarning className="size-8 text-muted-foreground" aria-hidden />
            <p>Preview unavailable.</p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
