import type { ChatCitationData, ChatGuardrailData } from './message-types';

export type ChatTextChunk =
  | { readonly type: 'text-start'; readonly id: string }
  | { readonly type: 'text-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'text-end'; readonly id: string };

export type ChatDataChunk =
  | { readonly type: 'data-citation'; readonly data: ChatCitationData }
  | { readonly type: 'data-guardrail'; readonly data: ChatGuardrailData }
  | { readonly type: 'data-conversation-persisted'; readonly data: { readonly conversationId: string } };

export type ChatChunk = ChatTextChunk | ChatDataChunk;

export interface ChatStreamWriter {
  write(chunk: ChatChunk): void;
}

export interface ChatStreamFactory {
  createStream(input: {
    readonly execute: (writer: ChatStreamWriter) => void;
  }): ReadableStream<ChatChunk>;
}

export interface ChatModelRef {
  readonly modelId: string;
}

export type ChatProviderOptions = Readonly<Record<string, unknown>>;
