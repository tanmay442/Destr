import type { UIMessage } from 'ai';

export type MyUIMessage = UIMessage<
  {
    citations?: Array<{
      similarity: number;
      snippet: string;
      fileName?: string | null;
      page?: number | null;
      sectionTitle?: string | null;
      source?: string | null;
    }>;
  },
  {
    citation: {
      similarity: number;
      snippet: string;
      fileName?: string | null;
      page?: number | null;
      sectionTitle?: string | null;
      source?: string | null;
    };
    guardrail: {
      outOfDomain: boolean;
      offerTicket: boolean;
    };
  }
>;
