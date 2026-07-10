import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getComposition, unwrap } from '@/composition';
import { Card } from '@/components/ui/card';
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
      <section className="flex flex-col gap-3" data-testid="document-preview">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-medium">{doc.fileName}</h2>
            <p className="text-xs text-muted-foreground">This document has been deleted. Restore it to preview.</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/documents">Back</Link>
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3" data-testid="document-preview">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium">{doc.fileName}</h2>
          <p className="text-xs text-muted-foreground">
            {doc.storageKey
              ? 'PDF stored in object storage'
              : 'Preview unavailable (no stored file)'}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/documents">Back</Link>
        </Button>
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
        <Card className="border-dashed p-6 text-center text-sm text-muted-foreground">
          Preview unavailable.
        </Card>
      )}
    </section>
  );
}
