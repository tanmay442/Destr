import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { NotFoundError } from '@app/domain';

const MAX_INGEST_BODY_BYTES = 1024 * 1024;
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

const processedSignatures = new Map<string, number>();

function pruneProcessedSignatures(now: number): void {
  for (const [signature, seenAt] of processedSignatures) {
    if (now - seenAt > REPLAY_MAX_AGE_MS) processedSignatures.delete(signature);
  }
}

function signatureTimestamp(signature: string): number | null {
  const payloadPart = signature.split('.')[1];
  if (!payloadPart) return null;
  let payload: string;
  try {
    payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  try {
    const { iat } = JSON.parse(payload) as { iat?: unknown };
    return typeof iat === 'number' && Number.isFinite(iat) ? iat : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    return NextResponse.json({ error: 'QStash signing keys not configured' }, { status: 401 });
  }
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_INGEST_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const body = await req.text();
  if (body.length > MAX_INGEST_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const signature = req.headers.get('upstash-signature') ?? '';
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  let isValid: boolean;
  try {
    isValid = await receiver.verify({ body, signature });
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (!isValid) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });

  const iat = signatureTimestamp(signature);
  if (iat === null) {
    return NextResponse.json({ error: 'Signature expired' }, { status: 401 });
  }
  const age = Date.now() - iat * 1000;
  if (age > REPLAY_MAX_AGE_MS || age < -REPLAY_MAX_AGE_MS) {
    return NextResponse.json({ error: 'Signature expired' }, { status: 401 });
  }

  const now = Date.now();
  pruneProcessedSignatures(now);
  const seenAt = processedSignatures.get(signature);
  if (seenAt !== undefined && now - seenAt <= REPLAY_MAX_AGE_MS) {
    return NextResponse.json({ ok: true, status: 'already-processed', chunks: 0 }, { status: 200 });
  }

  let documentId: unknown;
  try {
    documentId = JSON.parse(body).documentId;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Number.isInteger(documentId)) {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
  }

  processedSignatures.set(signature, now);
  let result;
  try {
    result = await getComposition().ingestQueuedDocument(documentId as number);
  } catch (error) {
    processedSignatures.delete(signature);
    throw error;
  }
  if (!result.ok) {
    processedSignatures.delete(signature);
    if (result.error instanceof NotFoundError) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 489, headers: { 'Upstash-NonRetryable-Error': 'true' } },
      );
    }
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
  }
  if (result.value.status === 'busy') {
    processedSignatures.delete(signature);
    return NextResponse.json({ error: 'Ingest in progress' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: result.value.status, chunks: result.value.chunks }, { status: 200 });
}
