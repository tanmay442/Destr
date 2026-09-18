import { z } from 'zod';
import { logger } from '@app/domain';
import type { ChatUIMessage } from './message-types';

/**
 * Model-aware, token-budgeted history compaction (WP-8 Task B, F-40).
 *
 * Replaces character-only history bounds with deterministic token accounting
 * so later agent steps resend a bounded dynamic suffix and preserve the
 * stable system/tool prefix share. This module only ever reorders/drops
 * conversation messages; it never sees, rewrites, or reorders the stable
 * system/tool prefix, and it never invents content: every kept message id is
 * a subset of the input ids.
 *
 * Preservation order (never dropped while present):
 *
 * 1. the current user request (explicit id, else the last user message),
 * 2. approval context ids (pending write-tool approvals),
 * 3. caller-marked constraint messages (recent user constraints),
 * 4. the most recent messages window.
 *
 * Compaction is deterministic truncation of the oldest unprotected messages
 * first. Summarization behind a version is represented by the dropped-id list
 * plus counts; no LLM summary is produced here so the outcome stays
 * deterministic and testable. The result records before/after token counts
 * and the compaction version.
 */

export const COMPACTION_VERSION = 'history-compaction-v1' as const;
export const HISTORY_SHAPE_VERSION = 'history-shape-v1' as const;
export const HISTORY_TOKEN_ESTIMATOR_VERSION = 'history-tokens-ceil4-v1' as const;

/** Deterministic character-to-token estimator: ceil(n/4), mirroring evidence packing. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function fileMetadataTokens(part: { url: string; mediaType: string; filename?: string | undefined }): number {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ url: part.url, filename: part.filename, mediaType: part.mediaType }),
  ).byteLength;
  return Math.max(1, Math.ceil(encoded / 4));
}

/** Deterministic per-message token estimate. Data parts are model-envelope overhead. */
export function estimateMessageTokens(message: ChatUIMessage): number {
  let total = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        total += estimateTextTokens(part.text);
        break;
      case 'file':
        total += fileMetadataTokens(part);
        break;
      case 'data-citation':
      case 'data-guardrail':
      case 'data-conversation-persisted':
        total += 0;
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(`history-compaction: unhandled part type ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return total;
}

export const HistoryCompactionOptionsSchema = z.object({
  maxInputTokens: z.number().int().positive().max(1_000_000),
  recentMessagesToKeep: z.number().int().min(1).max(100).default(8),
  currentRequestId: z.string().min(1).max(200).nullable().default(null),
  approvalContextIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  constraintMessageIds: z.array(z.string().min(1).max(200)).max(50).default([]),
});
export type HistoryCompactionOptions = z.infer<typeof HistoryCompactionOptionsSchema>;

export const HistoryCompactionOutcomeSchema = z.enum(['unchanged', 'compacted', 'over_budget']);
export type HistoryCompactionOutcome = z.infer<typeof HistoryCompactionOutcomeSchema>;

export const HistoryCompactionResultSchema = z.object({
  compactionVersion: z.literal(COMPACTION_VERSION),
  historyShapeVersion: z.literal(HISTORY_SHAPE_VERSION),
  tokenEstimatorVersion: z.literal(HISTORY_TOKEN_ESTIMATOR_VERSION),
  outcome: HistoryCompactionOutcomeSchema,
  beforeTokens: z.number().int().min(0),
  afterTokens: z.number().int().min(0),
  keptMessageIds: z.array(z.string()),
  droppedMessageIds: z.array(z.string()),
  preservedCurrentRequestId: z.string().nullable(),
  preservedApprovalContextIds: z.array(z.string()),
});
export type HistoryCompactionResult = z.infer<typeof HistoryCompactionResultSchema>;

/** Resolve the current request: explicit id when present, else the last user message. */
export function resolveCurrentRequestId(
  messages: readonly ChatUIMessage[],
  explicitId: string | null,
): string | null {
  if (explicitId !== null && messages.some((message) => message.id === explicitId)) return explicitId;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') return message.id;
  }
  const last = messages[messages.length - 1];
  return last === undefined ? null : last.id;
}

function uniquePresentIds(messages: readonly ChatUIMessage[], ids: readonly string[]): string[] {
  const known = new Set(messages.map((message) => message.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Compact conversation history to a deterministic token budget.
 *
 * `messages` are already-typed domain objects; the untrusted boundary is
 * `options`, validated with zod. The returned message list preserves input
 * order and contains only input messages.
 */
export function compactHistoryForModel(
  messages: readonly ChatUIMessage[],
  options: unknown,
): { readonly messages: readonly ChatUIMessage[]; readonly result: HistoryCompactionResult } {
  const parsed = HistoryCompactionOptionsSchema.parse(options);
  const tokenCounts = messages.map((message) => estimateMessageTokens(message));
  const beforeTokens = tokenCounts.reduce((total, count) => total + count, 0);
  const currentRequestId = resolveCurrentRequestId(messages, parsed.currentRequestId);
  const approvalIds = uniquePresentIds(messages, parsed.approvalContextIds);
  const constraintIds = uniquePresentIds(messages, parsed.constraintMessageIds);
  const recentIds = messages.slice(Math.max(0, messages.length - parsed.recentMessagesToKeep)).map((m) => m.id);

  const baseResult = {
    compactionVersion: COMPACTION_VERSION,
    historyShapeVersion: HISTORY_SHAPE_VERSION,
    tokenEstimatorVersion: HISTORY_TOKEN_ESTIMATOR_VERSION,
    beforeTokens,
    preservedCurrentRequestId: currentRequestId,
    preservedApprovalContextIds: approvalIds,
  } as const;

  if (messages.length === 0) {
    return {
      messages: [],
      result: Object.freeze({
        ...baseResult,
        outcome: 'unchanged',
        afterTokens: 0,
        keptMessageIds: [],
        droppedMessageIds: [],
      }),
    };
  }

  if (beforeTokens <= parsed.maxInputTokens) {
    return {
      messages,
      result: Object.freeze({
        ...baseResult,
        outcome: 'unchanged',
        afterTokens: beforeTokens,
        keptMessageIds: messages.map((message) => message.id),
        droppedMessageIds: [],
      }),
    };
  }

  const protectedIds = new Set<string>([
    ...(currentRequestId === null ? [] : [currentRequestId]),
    ...approvalIds,
    ...constraintIds,
    ...recentIds,
  ]);

  let protectedTokens = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && protectedIds.has(message.id)) protectedTokens += tokenCounts[index] ?? 0;
  }

  if (protectedTokens > parsed.maxInputTokens) {
    // Typed over-budget outcome: protected content alone exceeds the budget.
    // The current request is still never dropped; the caller must enforce a
    // harder policy (escalation, not silent truncation).
    const keptProtected = messages.filter((message) => protectedIds.has(message.id));
    const droppedIds = messages.filter((message) => !protectedIds.has(message.id)).map((m) => m.id);
    const afterTokens = keptProtected.reduce((total, message) => total + estimateMessageTokens(message), 0);
    logger.warn('history.compaction_over_budget', {
      beforeTokens,
      protectedTokens,
      maxInputTokens: parsed.maxInputTokens,
      keptCount: keptProtected.length,
      droppedCount: droppedIds.length,
    });
    return {
      messages: keptProtected,
      result: Object.freeze({
        ...baseResult,
        outcome: 'over_budget',
        afterTokens,
        keptMessageIds: keptProtected.map((message) => message.id),
        droppedMessageIds: droppedIds,
      }),
    };
  }

  // Two passes: protected messages are always kept; unprotected messages are
  // then kept newest-first while the remaining budget fits. Because protected
  // content fits on its own (checked above), this always terminates in budget
  // and drops the oldest unprotected messages first.
  let remaining = parsed.maxInputTokens - protectedTokens;
  const droppedIds = new Set<string>();
  const keptUnprotectedNewestFirst: ChatUIMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || protectedIds.has(message.id)) continue;
    const cost = tokenCounts[index] ?? 0;
    if (cost <= remaining) {
      keptUnprotectedNewestFirst.push(message);
      remaining -= cost;
    } else {
      droppedIds.add(message.id);
    }
  }
  keptUnprotectedNewestFirst.reverse();
  const keptById = new Set<string>([
    ...protectedIds,
    ...keptUnprotectedNewestFirst.map((message) => message.id),
  ]);
  const kept = messages.filter((message) => keptById.has(message.id));
  const droppedMessageIds = messages
    .filter((message) => droppedIds.has(message.id))
    .map((message) => message.id);

  const afterTokens = kept.reduce((total, message) => total + estimateMessageTokens(message), 0);
  logger.info('history.compacted', {
    beforeTokens,
    afterTokens,
    keptCount: kept.length,
    droppedCount: droppedMessageIds.length,
  });
  return {
    messages: kept,
    result: Object.freeze({
      ...baseResult,
      outcome: 'compacted',
      afterTokens,
      keptMessageIds: kept.map((message) => message.id),
      droppedMessageIds,
    }),
  };
}
