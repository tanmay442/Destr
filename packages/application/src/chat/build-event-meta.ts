import type { JudgeScores } from '@app/domain';

export interface EventMetaInput {
  rewritten?: boolean | undefined;
  documentIds?: number[] | undefined;
  ticketId?: string | null | undefined;
  degraded?: boolean | undefined;
  fallbackReason?: string | undefined;
  isEmpty?: boolean | undefined;
  resultState?: string | undefined;
  
  judgeScores?: (JudgeScores & { judgedAt: string }) | undefined;
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
  if (input.degraded !== undefined) meta.degraded = input.degraded;
  if (input.fallbackReason !== undefined) meta.fallbackReason = input.fallbackReason;
  if (input.isEmpty !== undefined) meta.isEmpty = input.isEmpty;
  if (input.resultState !== undefined) meta.resultState = input.resultState;
  if (input.judgeScores !== undefined) meta.judgeScores = { ...input.judgeScores };
  return meta;
}
