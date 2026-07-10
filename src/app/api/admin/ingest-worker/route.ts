import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { NotFoundError } from '@app/domain';

// QStash async ingest callback; non-2xx → QStash retries; ingestQueuedDocument is idempotent.
export async function POST(req: Request) {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    return NextResponse.json({ error: 'QStash signing keys not configured' }, { status: 401 });
  }
  // Receiver.verify needs the raw body string; req.json() consumes the stream.
  const body = await req.text();
  const signature = req.headers.get('upstash-signature') ?? '';
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  let isValid: boolean;
  try {
    isValid = await receiver.verify({ body, signature });
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (!isValid) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });

  let documentId: unknown;
  try {
    documentId = JSON.parse(body).documentId;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Number.isInteger(documentId)) {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
  }

  const result = await getComposition().ingestQueuedDocument(documentId as number);
  if (!result.ok) {
    if (result.error instanceof NotFoundError) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
  }
  if (result.value.status === 'busy') {
    return NextResponse.json({ error: 'Ingest in progress' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: result.value.status, chunks: result.value.chunks }, { status: 200 });
}
