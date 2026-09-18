import type { UIMessage } from 'ai';
import type { RetrievalScores } from '@app/application/rag/search';

export interface CitationData {
  id?: number;
  documentId?: number;
  documentUid?: string;
  chunkUid?: string;
  scores?: RetrievalScores;
  /** Legacy cache/history field. Never render as a cross-modality percentage. */
  similarity?: number;
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

/**
 * Transient wire payload for `data-agent-progress` stream parts (WP-8 F-29).
 * Mirrors the server `AgentProgressEvent` shape. Stream data is untrusted:
 * the collector in ChatInterface.tsx validates every field with guards and
 * treats unknown/malformed fields as absent, so only validated values flow
 * into `AgentProgressViewEvent`.
 */
export interface AgentProgressData {
  /** Progress stream identity, 1-100 chars. */
  id: string;
  /** One of: accepted/checking_cache/planning/searching/reranking/reading_sources/drafting/verifying/saving/complete/degraded/cancelled. */
  phase: string;
  /** One of: started/updated/completed/failed. */
  status: string;
  /** Bounded label code; rendered only through the fixed AgentProgress map. */
  labelCode: string;
  elapsedMs: number;
  callId?: string;
  subquestionId?: string;
  completed?: number;
  total?: number;
}

export type MyUIMessage = UIMessage<
  {
    citations?: CitationData[];
  },
  {
    citation: CitationData;
    guardrail: GuardrailData;
    'conversation-persisted': { conversationId: string };
    'agent-progress': AgentProgressData;
  }
>;
