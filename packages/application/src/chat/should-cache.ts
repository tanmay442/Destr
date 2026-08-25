import type { AppConfig } from '@app/domain';
import type { EmittedCitation } from './emit-citations';

/** Arguments for {@link shouldCache}; `isEmpty` is the agentic empty-wall flag. */
export interface ShouldCacheInput {
  citations: EmittedCitation[];
  blocked: boolean;
  isEmpty: boolean;
  ticketCreated: boolean;
  cfg: AppConfig;

  hallucinationTimedOut?: boolean;
}

export function shouldCache({ citations, blocked, isEmpty, ticketCreated, cfg, hallucinationTimedOut }: ShouldCacheInput): boolean {
  return (
    citations.length > 0 &&
    !blocked &&
    !isEmpty &&
    !ticketCreated &&
    !hallucinationTimedOut &&
    cfg.hallucinationCheckEnabled
  );
}
