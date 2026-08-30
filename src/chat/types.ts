import type { UIMessage } from 'ai';

export interface CitationData {
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

export interface GuardrailData {
  outOfDomain: boolean;
  offerTicket: boolean;
  /** Soft informational banner; no ticket offer. */
  notice?: boolean;
  message?: string;
  isEmpty?: boolean;
  resultState?: string;
}

export type MyUIMessage = UIMessage<
  {
    citations?: CitationData[];
  },
  {
    citation: CitationData;
    guardrail: GuardrailData;
    'conversation-persisted': { conversationId: string };
  }
>;
