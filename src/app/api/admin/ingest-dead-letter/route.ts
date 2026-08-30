import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { readBoundedText } from '@/lib/http';
import { logger } from '@app/domain';

const MAX_DLQ_BODY_BYTES = 1024 * 1024;
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function nestedMessage(value: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value.body)) return value.body;
  if (typeof value.body !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value.body);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
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
  const bounded = await readBoundedText(req, MAX_DLQ_BODY_BYTES);
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
  if (iat === null || Math.abs(Date.now() - iat * 1000) > REPLAY_MAX_AGE_MS) {
    return NextResponse.json({ error: 'Signature expired' }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isRecord(parsed)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const message = nestedMessage(parsed);
  const documentId = parsed.documentId ?? message.documentId;
  if (typeof documentId !== 'number' || !Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
  }
  let fileHash: unknown = parsed.fileHash ?? message.fileHash;
  if (!isSha256(fileHash)) {
    logger.warn('[ingest-dlq] missing or invalid fileHash, falling back to current document hash', { documentId, fileHash });
    try {
      const lookup = await getComposition().getDocumentById(documentId, { includeDeleted: true });
      if (lookup.ok && lookup.value.document?.fileHash && isSha256(lookup.value.document.fileHash)) {
        fileHash = lookup.value.document.fileHash;
      } else {
        logger.warn('[ingest-dlq] cannot resolve fileHash for DLQ, recording dead-letter without hash-conditional fail', { documentId });
        const error =
          req.headers.get('upstash-error-code') ??
          req.headers.get('upstash-error') ??
          'QStash ingest delivery failed after retry budget exhausted';
        await getComposition().ingestDeadLetter({ documentId, fileHash: '0'.repeat(64), payload: parsed, error });
        return NextResponse.json({ ok: true, documentId, warning: 'fileHash missing, dead-letter recorded without fail' }, { status: 200 });
      }
    } catch (e) {
      logger.warn('[ingest-dlq] fileHash fallback lookup failed', { documentId, error: e });
      return NextResponse.json({ error: 'Invalid fileHash' }, { status: 400 });
    }
  }

  const error =
    req.headers.get('upstash-error-code') ??
    req.headers.get('upstash-error') ??
    'QStash ingest delivery failed after retry budget exhausted';

  await getComposition().ingestDeadLetter({ documentId, fileHash: fileHash as string, payload: parsed, error });
  return NextResponse.json({ ok: true, documentId }, { status: 200 });
}
