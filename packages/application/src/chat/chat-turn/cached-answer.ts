import type { InferUIMessageChunk } from 'ai';
import { dedupeCitations } from '../dedupe-citations';
import type { EmittedCitation } from '../emit-citations';
import type { ChatUIMessage } from '../message-types';
import { TURN_FINGERPRINT_VERSION } from '../turn-fingerprint';
import type { AiSdk } from './turn-types';

type UIMessage = ChatUIMessage;

const TURN_RESULT_CACHE_TTL_SEC = 86_400;

export { TURN_RESULT_CACHE_TTL_SEC };

interface CachedAnswerPayload {
  text: string;
  citations: EmittedCitation[];
  requestFingerprint?: string;
  fingerprintVersion?: number;
  guardrail?: {
    outOfDomain: boolean;
    offerTicket: boolean;
    notice?: boolean;
    message?: string;
    isEmpty?: boolean;
    resultState?: string;
  };
}

export type { CachedAnswerPayload };

function parseCachedAnswer(value: string): CachedAnswerPayload;
function parseCachedAnswer(value: string, expectedKind: 'turn-result'): CachedAnswerPayload | null;
function parseCachedAnswer(value: string, expectedKind?: 'turn-result'): CachedAnswerPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as {
        v?: unknown;
        kind?: unknown;
        text?: unknown;
        citations?: unknown;
        requestFingerprint?: unknown;
        fingerprintVersion?: unknown;
        guardrail?: unknown;
      };
      if (
        candidate.v === 1 &&
        (expectedKind === undefined || candidate.kind === expectedKind) &&
        typeof candidate.text === 'string' &&
        Array.isArray(candidate.citations) &&
        candidate.citations.every(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Record<string, unknown>).snippet === 'string',
        )
      ) {
        const result: CachedAnswerPayload = {
          text: candidate.text,
          citations: candidate.citations as EmittedCitation[],
        };
        if (typeof candidate.requestFingerprint === 'string') {
          result.requestFingerprint = candidate.requestFingerprint;
        };
        if (typeof candidate.fingerprintVersion === 'number') {
          result.fingerprintVersion = candidate.fingerprintVersion;
        }
        if (typeof candidate.guardrail === 'object' && candidate.guardrail !== null) {
          result.guardrail = candidate.guardrail as NonNullable<CachedAnswerPayload['guardrail']>;
        }
        return result;
      }
    }
  } catch {
  }
  return expectedKind === undefined ? { text: value, citations: [] } : null;
}

export { parseCachedAnswer };

function parseTurnResult(
  value: string,
  requestFingerprint: { current: string; legacy: string },
): { answer: CachedAnswerPayload } | { conflict: true } | null {
  const answer = parseCachedAnswer(value, 'turn-result');
  if (!answer) return null;
  const expected = answer.fingerprintVersion === TURN_FINGERPRINT_VERSION
    ? requestFingerprint.current
    : requestFingerprint.legacy;
  if (answer.requestFingerprint !== expected) return { conflict: true };
  return { answer };
}

export { parseTurnResult };

function createCachedAnswerStream(
  ai: AiSdk,
  cachedAnswer: CachedAnswerPayload,
  historyPersisted: boolean,
  conversationId: string | undefined,
): ReadableStream<InferUIMessageChunk<UIMessage>> {
  return ai.createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'text-start', id: 'cached' });
      writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
      writer.write({ type: 'text-end', id: 'cached' });
      for (const citation of dedupeCitations(cachedAnswer.citations)) {
        writer.write({ type: 'data-citation', data: citation });
      }
      if (cachedAnswer.guardrail) {
        writer.write({ type: 'data-guardrail', data: cachedAnswer.guardrail });
      }
      if (historyPersisted && conversationId) {
        writer.write({
          type: 'data-conversation-persisted',
          data: { conversationId },
        });
      }
    },
  });
}

export { createCachedAnswerStream };
