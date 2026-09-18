import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getComposition } from '@/composition';
import { decodeJudgePayload } from '@app/application/capacity/background-queue';
import { getMetaPatchers, runJudge } from '@/app/api/chat/judge';
import { readBoundedText } from '@/lib/http';

/**
 * Durable sampled-judge worker (WP-8 F-39).
 *
 * Consumes judge jobs published by the durable background queue (QStash when
 * QSTASH_TOKEN + worker URL are configured). Authentication is the QStash
 * signature, mirroring the ingest-worker route; there is no admin session on
 * this path. Delivery is at-least-once: the turn ID is the idempotency key
 * and judge scoring overwrites the same turn's judgeScores, so repeats are
 * safe. Validation failures are non-retryable (400/401); handler errors are
 * 500 so QStash retries within its budget.
 */

const MAX_JUDGE_BODY_BYTES = 256 * 1024;
const REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function signatureTimestamp(signature: string): number | null {
  const payloadPart = signature.split('.')[1];
  if (!payloadPart) return null;
  try {
    const payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
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
  if (Number.isFinite(contentLength) && contentLength > MAX_JUDGE_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const bounded = await readBoundedText(req, MAX_JUDGE_BODY_BYTES);
  if (!bounded.ok) {
    return NextResponse.json(
      { error: bounded.reason === 'too-large' ? 'Payload too large' : 'Invalid request body' },
      { status: bounded.reason === 'too-large' ? 413 : 400 },
    );
  }
  const signature = req.headers.get('upstash-signature') ?? '';
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  let isValid: boolean;
  try {
    isValid = await receiver.verify({ body: bounded.text, signature });
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
    payload = JSON.parse(bounded.text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isRecord(payload) || payload.kind !== 'judge') {
    return NextResponse.json({ error: 'Invalid judge job' }, { status: 400 });
  }
  const turnId = typeof payload.turnId === 'string' && payload.turnId !== '' ? payload.turnId : null;
  if (turnId === null) {
    return NextResponse.json({ error: 'Invalid judge job' }, { status: 400 });
  }
  // Flat string-map payload per the shared codec (snippets travel as JSON);
  // malformed payloads are non-retryable 400s, never partial work.
  const decoded = decodeJudgePayload(payload.payload);
  if (decoded === null) {
    return NextResponse.json({ error: 'Invalid judge payload' }, { status: 400 });
  }
  const { question, snippets, documents, answer } = decoded;

  const comp = getComposition();
  const patchers = getMetaPatchers(comp);
  await runJudge({
    question,
    snippets: [...snippets],
    documents,
    answer,
    turnId,
    eventMetaPatcher: patchers.eventMeta,
    batcherPatcher: patchers.batcher,
  });
  return NextResponse.json({ ok: true }, { status: 200 });
}
