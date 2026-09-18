import type { ChatCitationData, ChatGuardrailData } from './message-types';
import type { AgentProgressEvent } from './progress/progress-event';

export type ChatTextChunk =
  | { readonly type: 'text-start'; readonly id: string }
  | { readonly type: 'text-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'text-end'; readonly id: string };

export type ChatDataChunk =
  | { readonly type: 'data-citation'; readonly data: ChatCitationData }
  | { readonly type: 'data-guardrail'; readonly data: ChatGuardrailData }
  | { readonly type: 'data-conversation-persisted'; readonly data: { readonly conversationId: string } }
  | {
      /**
       * Transient server-driven progress (WP-8 F-29/F-42). Transport-only:
       * never persisted in history, never sent to the model, never cached,
       * never embedded in grounding evidence (see progress-event.ts). The
       * payload carries only bounded codes/counters, so redaction is
       * structural. Emitted only when WP8_SERVER_PROGRESS_ENABLED=1.
       */
      readonly type: 'data-agent-progress';
      readonly data: AgentProgressEvent;
    };

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
