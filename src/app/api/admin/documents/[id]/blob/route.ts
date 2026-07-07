import { NextResponse } from 'next/server';
import { requireAdminDocument } from '@/composition';

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminDocument(context);
  if (!auth.ok) return auth.response;
  const safeName = auth.document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const storageKey = auth.document.storageKey!;
  const comp = auth.comp;

  // R2/S3 adapters expose a signedUrl — redirect so the PDF is served
  // straight from the object-store edge instead of streaming through
  // the function. The filesystem adapter has no signedUrl, so fall back
  // to streaming the bytes back.
  if (comp.blobStorage.signedUrl) {
    const url = await comp.blobStorage.signedUrl(storageKey, 300);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  }
  const stream = await comp.blobStorage.stream(storageKey);
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
