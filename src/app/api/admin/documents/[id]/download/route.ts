import { NextResponse } from 'next/server';
import { requireAdminDocument } from '@/composition';

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminDocument(context, { allowDeleted: true });
  if (!auth.ok) return auth.response;
  const safeName = auth.document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const storageKey = auth.document.storageKey!;
  const comp = auth.comp;

  // Force a download (Content-Disposition: attachment). Same
  // redirect-vs-stream strategy as the blob preview route.
  if (comp.blobStorage.signedUrl) {
    const url = await comp.blobStorage.signedUrl(storageKey, 300);
    return NextResponse.redirect(url, {
      status: 302,
      headers: {
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `attachment; filename="${safeName}"`,
      },
    });
  }
  const stream = await comp.blobStorage.stream(storageKey);
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
