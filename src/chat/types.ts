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

export type MyUIMessage = UIMessage<
  {
    citations?: CitationData[];
  },
  {
    citation: CitationData;
    guardrail: {
      outOfDomain: boolean;
      offerTicket: boolean;
    };
  }
>;
