import type { MyUIMessage } from './types';

export interface StoredMessagePayload {
  id: number;
  turnId: string | null;
  role: 'user' | 'assistant';
  content: unknown;
}

export interface ResumedConversation {
  messages: MyUIMessage[];
  /** Assistant message id -> originating turn id, so thumbs feedback still attributes correctly. */
  turnIds: Record<string, string>;
  messageCount: number;
}

interface StoredContent {
  id?: unknown;
  role?: unknown;
  parts?: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rebuild live UI messages from whitelisted snapshots: data-citation parts and the guardrail signal are synthesised from metadata. */
export function toResumedConversation(input: {
  messages: StoredMessagePayload[];
  messageCount?: number;
}): ResumedConversation {
  const messages: MyUIMessage[] = [];
  const turnIds: Record<string, string> = {};

  for (const stored of input.messages ?? []) {
    if (!stored) continue;
    const content = isRecord(stored.content) ? (stored.content as StoredContent) : {};
    const rawParts = Array.isArray(content.parts) ? content.parts : [];
    const parts: MyUIMessage['parts'] = [];

    for (const part of rawParts) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type === 'text' && typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
      } else if (type === 'reasoning') {
        const reasoning: { type: 'reasoning'; text?: string } = { type: 'reasoning' };
        if (typeof part.text === 'string') reasoning.text = part.text;
        parts.push(reasoning as unknown as MyUIMessage['parts'][number]);
      } else if (
        type === 'file' &&
        typeof part.url === 'string' &&
        /^https?:\/\//i.test(part.url)
      ) {
        parts.push({
          type: 'file',
          url: part.url,
          ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
          ...(typeof part.mediaType === 'string' ? { mediaType: part.mediaType } : {}),
        } as unknown as MyUIMessage['parts'][number]);
      }
    }

    const metadata = isRecord(content.metadata) ? content.metadata : {};
    if (Array.isArray(metadata.citations)) {
      for (const citation of metadata.citations) {
        if (isRecord(citation)) {
          parts.push({
            type: 'data-citation',
            data: citation,
          } as unknown as MyUIMessage['parts'][number]);
        }
      }
    }
    if (isRecord(metadata.guardrail)) {
      const guardrail = metadata.guardrail;
      parts.push({
        type: 'data-guardrail',
        data: {
          outOfDomain: Boolean(guardrail.outOfDomain),
          offerTicket: Boolean(guardrail.offerTicket),
          ...(typeof guardrail.notice === 'boolean' ? { notice: guardrail.notice } : {}),
          ...(typeof guardrail.message === 'string' && guardrail.message !== ''
            ? { message: guardrail.message }
            : {}),
          ...(typeof guardrail.isEmpty === 'boolean' ? { isEmpty: guardrail.isEmpty } : {}),
          ...(typeof guardrail.resultState === 'string' && guardrail.resultState !== ''
            ? { resultState: guardrail.resultState }
            : {}),
        },
      } as unknown as MyUIMessage['parts'][number]);
    }

    const messageId =
      typeof content.id === 'string' && content.id !== '' ? content.id : `stored-${stored.id}`;
    messages.push({
      id: messageId,
      role: stored.role,
      parts,
    });
    if (stored.role === 'assistant' && typeof stored.turnId === 'string') {
      turnIds[messageId] = stored.turnId;
    }
  }

  return { messages, turnIds, messageCount: input.messageCount ?? input.messages?.length ?? 0 };
}
