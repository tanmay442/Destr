import type { AgenticResultState, JudgeScores } from '@app/domain';
import type { RetrievalScores } from '../rag/search';

export interface EventMetaInput {
  rewritten?: boolean | undefined;
  documentIds?: number[] | undefined;
  ticketId?: string | null | undefined;
  fallbackReason?: string | undefined;
  isEmpty?: boolean | undefined;
  resultState?: string | undefined;
  searchResultStates?: AgenticResultState[] | undefined;
  retrievalScoreMaxima?: Partial<Pick<RetrievalScores, 'dense' | 'lexical' | 'fusion' | 'reranker'>> | undefined;

  /** Provider/model and cache facts supplied by the infrastructure adapter. */
  modelTelemetry?: Record<string, unknown> | undefined;
  promptCache?: Record<string, unknown> | undefined;
  /** Prefetch/retrieval timings are kept in meta to preserve the event port. */
  prefetchStatus?: 'disabled' | 'performed' | 'exact_match_reused' | 'query_changed' | undefined;
  prefetchMs?: number | null | undefined;
  reformulationCount?: number | undefined;
  retrievalProvider?: string | undefined;
  retrievalMode?: 'agentic' | 'vector' | undefined;

  judgeScores?: (JudgeScores & { judgedAt: string }) | undefined;
  /** Pre-release grounding decision telemetry (secret-free counts/enums only). */
  grounding?: Record<string, number | string | boolean | null> | undefined;
}

/**
 * Presence-based meta builder: quality/agentic fields are written whenever
 * defined (including `false`/`''`), unlike the legacy truthy-only signals.
 */
export function buildEventMeta(input: EventMetaInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.rewritten) meta.rewritten = true;
  if (input.documentIds && input.documentIds.length > 0) {
    meta.documentIds = [...new Set(input.documentIds.filter((id) => typeof id === 'number' && id > 0))];
  }
  if (input.ticketId) meta.ticketId = input.ticketId;
  if (input.fallbackReason !== undefined) meta.fallbackReason = input.fallbackReason;
  if (input.isEmpty !== undefined) meta.isEmpty = input.isEmpty;
  if (input.resultState !== undefined) meta.resultState = input.resultState;
  if (input.searchResultStates !== undefined || input.retrievalScoreMaxima !== undefined) {
    meta.search = {
      ...(input.searchResultStates !== undefined ? { resultStates: [...input.searchResultStates] } : {}),
      ...(input.retrievalScoreMaxima !== undefined ? { scoreMaxima: { ...input.retrievalScoreMaxima } } : {}),
    };
  }
  if (input.modelTelemetry !== undefined) meta.model = { ...input.modelTelemetry };
  if (input.promptCache !== undefined) meta.promptCache = { ...input.promptCache };
  if (input.prefetchStatus !== undefined || input.prefetchMs !== undefined) {
    meta.prefetch = {
      ...(input.prefetchStatus !== undefined ? { status: input.prefetchStatus } : {}),
      ...(input.prefetchMs !== undefined ? { latencyMs: input.prefetchMs } : {}),
    };
  }
  if (input.reformulationCount !== undefined) meta.reformulationCount = input.reformulationCount;
  if (input.retrievalProvider !== undefined || input.retrievalMode !== undefined) {
    meta.retrieval = {
      ...(input.retrievalProvider !== undefined ? { provider: input.retrievalProvider } : {}),
      ...(input.retrievalMode !== undefined ? { mode: input.retrievalMode } : {}),
    };
  }
  if (input.judgeScores !== undefined) meta.judgeScores = { ...input.judgeScores };
  if (input.grounding !== undefined) meta.grounding = { ...input.grounding };
  return meta;
}
