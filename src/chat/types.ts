import type { UIMessage } from 'ai';

export interface CitationData {
  id?: number;
  documentId?: number;
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
  /** Soft best-effort banner (top-4 fallback); no ticket offer. */
  degraded?: boolean;
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
  }
>;
