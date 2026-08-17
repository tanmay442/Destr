import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';

const MAX_DLQ_BODY_BYTES = 1024 * 1024;
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

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

/**
 * QStash dead-letter endpoint. QStash delivers messages that exhausted their
 * retry budget here (QSTASH_DLQ_URL). Gated solely by the QStash signature,
 * like the ingest-worker; the failure is persisted and the document is marked
 * `failed` so it becomes visible in the admin UI instead of silently stuck.
 */
export async function POST(req: Request) {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    return NextResponse.json({ error: 'QStash signing keys not configured' }, { status: 401 });
  }
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DLQ_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const body = await req.text();
  if (body.length > MAX_DLQ_BODY_BYTES) {
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
  if (iat === null || Date.now() - iat * 1000 > REPLAY_MAX_AGE_MS) {
    return NextResponse.json({ error: 'Signature expired' }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const record = parsed as { documentId?: unknown; body?: { documentId?: unknown } };
  const documentId = record.documentId ?? record.body?.documentId;
  if (!Number.isInteger(documentId)) {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
  }

  const error =
    req.headers.get('upstash-error-code') ??
    req.headers.get('upstash-error') ??
    'QStash ingest delivery failed after retry budget exhausted';

  await getComposition().ingestDeadLetter({ documentId: documentId as number, payload: parsed, error });
  return NextResponse.json({ ok: true, documentId }, { status: 200 });
}
