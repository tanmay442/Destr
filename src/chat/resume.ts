import type { MyUIMessage } from './types';
import { extractContentParts, isRecord } from './resume/parts';
import { extractMetadataParts } from './resume/metadata';

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

/** Rebuild live UI messages from whitelisted snapshots: data-citation parts and the guardrail signal are synthesised from metadata. */
export function toResumedConversation(input: {
  messages: StoredMessagePayload[];
  messageCount?: number;
}): ResumedConversation {
  const messages: MyUIMessage[] = [];
  const turnIds: Record<string, string> = {};

  for (const stored of input.messages ?? []) {
    if (!stored) continue;
    const content = isRecord(stored.content) ? stored.content : {};
    const parts: MyUIMessage['parts'] = [
      ...extractContentParts(content),
      ...extractMetadataParts(content),
    ];

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
