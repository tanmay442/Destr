import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { NotFoundError } from '@app/domain';

/** QStash callback endpoint for async PDF ingest. QStash POSTs here
 *  with `{ documentId }` after the upload use-case enqueues a message.
 *  The signature is verified against `QSTASH_CURRENT_SIGNING_KEY` /
 *  `QSTASH_NEXT_SIGNING_KEY`; non-2xx responses make QStash retry
 *  (up to the `retries` budget set at publish time).
 *
 *  Idempotency: `ingestQueuedDocument` checks `ingest_status` first
 *  — a `done` doc returns `already-done` (200, no re-processing) and
 *  an `ingesting` doc returns `busy` (409, retry later). Only
 *  `queued`/`failed` docs are processed. The chunk insert + `done`
 *  flip happen in one transaction, so a retry that arrives after a
 *  committed ingest is a no-op. */
export async function POST(req: Request) {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    return NextResponse.json({ error: 'QStash signing keys not configured' }, { status: 401 });
  }
  // Read the body as text first — `Receiver.verify` needs the raw
  // string and `req.json()` would consume the stream.
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
    // Non-2xx → QStash retries. `ingest_status` is already `failed`,
    // but a retry may still succeed (transient embed API outage).
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
  }
  if (result.value.status === 'busy') {
    // Another worker is mid-ingest; ask QStash to retry later.
    return NextResponse.json({ error: 'Ingest in progress' }, { status: 409 });
  }
  // `done` or `already-done` → 200.
  return NextResponse.json({ ok: true, status: result.value.status, chunks: result.value.chunks }, { status: 200 });
}
