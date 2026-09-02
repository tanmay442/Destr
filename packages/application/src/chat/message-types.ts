import type { UIMessage } from 'ai';
import type { ValidatedChatFile } from './chat-file';

export interface ChatCitationData {
  id?: number;
  documentId?: number;
  documentUid?: string;
  chunkUid?: string;
  similarity: number;
  snippet: string;
  fileName?: string | null;
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
}

export interface ChatGuardrailData {
  outOfDomain: boolean;
  offerTicket: boolean;
  notice?: boolean;
  message?: string;
  isEmpty?: boolean;
  resultState?: string;
}

export type ChatDataParts = {
  citation: ChatCitationData;
  guardrail: ChatGuardrailData;
  'conversation-persisted': { conversationId: string };
};

export type ChatUIMessage = UIMessage<
  { citations?: ChatCitationData[] },
  ChatDataParts
>;

export type ChatInputPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string }
  | ValidatedChatFile;

export interface ChatInputMessage {
  id?: string;
  role: 'user' | 'assistant';
  parts: ChatInputPart[];
}

export const MAX_MODEL_HISTORY_MESSAGES = 24;
export const MAX_MODEL_HISTORY_TEXT_CHARS = 50_000;

function messageTextChars(message: ChatUIMessage): number {
  return message.parts.reduce(
    (total, part) => {
      if (part.type === 'text' || part.type === 'reasoning') return total + part.text.length;
      if (part.type === 'file') {
        return total + new TextEncoder().encode(JSON.stringify({
          url: part.url,
          filename: part.filename,
          mediaType: part.mediaType,
        })).byteLength;
      }
      return total;
    },
    0,
  );
}

export function compactModelHistory(
  messages: ChatUIMessage[],
  maxMessages = MAX_MODEL_HISTORY_MESSAGES,
  maxTextChars = MAX_MODEL_HISTORY_TEXT_CHARS,
): ChatUIMessage[] {
  const selected: ChatUIMessage[] = [];
  let textChars = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = messages[index]!;
    const nextTextChars = textChars + messageTextChars(message);
    if (selected.length > 0 && nextTextChars > maxTextChars) break;
    selected.push(message);
    textChars = nextTextChars;
  }
  return selected.reverse();
}

export function toChatUIMessages(messages: ChatInputMessage[]): ChatUIMessage[] {
  return messages.map((message, messageIndex) => ({
    id: message.id ?? `message-${messageIndex}`,
    role: message.role,
    parts: message.parts.map((part): ChatUIMessage['parts'][number] => {
      switch (part.type) {
        case 'text':
          return part;
        case 'reasoning':
          return { type: 'reasoning', text: part.text ?? '' };
        case 'file':
          return {
            type: 'file',
            url: part.url,
            mediaType: part.mediaType,
            ...(part.filename !== undefined ? { filename: part.filename } : {}),
          };
      }
    }),
  }));
}
