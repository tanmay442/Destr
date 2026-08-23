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

/** Server-emitted guardrail payload: hard wall (ticket offer) or soft degraded banner [§A4]. */
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
