import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { readBoundedText } from '@/lib/http';
import { NotFoundError } from '@app/domain';

const MAX_INGEST_BODY_BYTES = 1024 * 1024;
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
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
  const bounded = await readBoundedText(req, MAX_INGEST_BODY_BYTES);
  if (!bounded.ok) {
    return NextResponse.json(
      { error: bounded.reason === 'too-large' ? 'Payload too large' : 'Invalid request body' },
      { status: bounded.reason === 'too-large' ? 413 : 400 },
    );
  }
  const body = bounded.text;
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


  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const documentId = payload.documentId;
  if (!isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
  }
  const rawFileHash = payload.fileHash;
  if (rawFileHash !== undefined && !isSha256(rawFileHash)) {
    return NextResponse.json({ error: 'Invalid fileHash' }, { status: 400 });
  }

  const result = rawFileHash === undefined
    ? await getComposition().ingestQueuedDocument(documentId)
    : await getComposition().ingestQueuedDocument(documentId, rawFileHash);
  if (!result.ok) {
    if (result.error instanceof NotFoundError) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 489, headers: { 'Upstash-NonRetryable-Error': 'true' } },
      );
    }
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
  }
  if (result.value.status === 'busy') {
    return NextResponse.json({ error: 'Ingest in progress' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: result.value.status, chunks: result.value.chunks }, { status: 200 });
}
