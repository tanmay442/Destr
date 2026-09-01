import { createHash } from 'node:crypto';
import type { ChatInputMessage } from './message-types';

export const TURN_FINGERPRINT_VERSION = 2;

type CanonicalPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; url: string; filename: string | null; mediaType: string };

interface CanonicalTurnRequest {
  v: typeof TURN_FINGERPRINT_VERSION;
  conversationId: string | null;
  retry: boolean;
  semanticContext: string | null;
  messages: Array<{ role: 'user' | 'assistant'; parts: CanonicalPart[] }>;
}

function canonicalPart(part: ChatInputMessage['parts'][number]): CanonicalPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text ?? '' };
    case 'file':
      return {
        type: 'file',
        url: part.url,
        filename: part.filename ?? null,
        mediaType: part.mediaType,
      };
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

export function canonicalTurnRequest(input: {
  conversationId?: string | undefined;
  retry?: boolean | undefined;
  semanticContext?: string | undefined;
  messages: ChatInputMessage[];
}): CanonicalTurnRequest {
  return {
    v: TURN_FINGERPRINT_VERSION,
    conversationId: input.conversationId ?? null,
    retry: input.retry === true,
    semanticContext: input.semanticContext ?? null,
    messages: input.messages.map((message) => ({
      role: message.role,
      parts: message.parts.map(canonicalPart),
    })),
  };
}

export function turnRequestFingerprint(input: Parameters<typeof canonicalTurnRequest>[0]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalTurnRequest(input)))
    .digest('hex');
}

/** Compatibility-only hash for turn-result records written before fingerprint v2. */
export function legacyTurnRequestFingerprint(input: {
  conversationId?: string | undefined;
  messages: ChatInputMessage[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ conversationId: input.conversationId ?? null, messages: input.messages }))
    .digest('hex');
}
