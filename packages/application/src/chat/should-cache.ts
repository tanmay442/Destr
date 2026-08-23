import type { AppConfig } from '@app/domain';
import type { AgenticResult } from '../rag/agentic-search';
import type { EmittedCitation } from './emit-citations';

/** Arguments for {@link shouldCache}; `isEmpty` is the agentic empty-wall flag. */
export interface ShouldCacheInput {
  citations: EmittedCitation[];
  blocked: boolean;
  isEmpty: boolean;
  ticketCreated: boolean;
  cfg: AppConfig;
  agentic: AgenticResult;
}

/**
 * §B1 shared cache-exclusion gate for BOTH pipeline copies (route.ts /
 * chat-turn.ts): degraded turns (grader outage, all-filtered, grading toggle
 * off) and hallucination-check-off turns must never poison the answer cache.
 */
export function shouldCache({ citations, blocked, isEmpty, ticketCreated, cfg, agentic }: ShouldCacheInput): boolean {
  return (
    citations.length > 0 &&
    !blocked &&
    !isEmpty &&
    !ticketCreated &&
    cfg.hallucinationCheckEnabled &&
    !agentic.degraded && // covers grader_unavailable + all_filtered + grading_disabled
    cfg.agenticChunkGradingEnabled !== false
  );
}
