import type { UIMessage } from 'ai';

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
  | {
      type: 'file';
      url: string;
      filename?: string;
      mediaType?: string;
    };

export interface ChatInputMessage {
  id?: string;
  role: 'user' | 'assistant';
  parts: ChatInputPart[];
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
            mediaType: part.mediaType ?? 'application/octet-stream',
            ...(part.filename !== undefined ? { filename: part.filename } : {}),
          };
      }
    }),
  }));
}
