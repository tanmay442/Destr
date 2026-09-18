import { z } from 'zod';

/**
 * Typed transient progress events (WP-8 Task A, F-29/F-42).
 *
 * Progress describes observable operations, never hidden reasoning. The event
 * carries only bounded codes and counters, so redaction is structural: there
 * is no field for raw queries, tool arguments, provider errors, document
 * text, ticket contents, secrets, or unbounded identifiers.
 *
 * Transience contract (`PROGRESS_PART_TYPE = 'data-agent-progress'`): progress
 * parts are transport-only. They must never be persisted in conversation
 * history, sent back to the model, stored in the answer cache, or embedded in
 * grounding evidence. `stripProgressParts` / `assertProgressTransient` pin
 * that contract for callers and tests.
 */

export const PROGRESS_PART_TYPE = 'data-agent-progress' as const;

export const AGENT_PROGRESS_PHASES = [
  'accepted',
  'checking_cache',
  'planning',
  'searching',
  'reranking',
  'reading_sources',
  'drafting',
  'verifying',
  'saving',
  'complete',
  'degraded',
  'cancelled',
] as const;
export type AgentProgressPhase = (typeof AGENT_PROGRESS_PHASES)[number];
export const AgentProgressPhaseSchema = z.enum(AGENT_PROGRESS_PHASES);

export const TERMINAL_PROGRESS_PHASES = ['complete', 'degraded', 'cancelled'] as const;
export type TerminalProgressPhase = (typeof TERMINAL_PROGRESS_PHASES)[number];

export function isTerminalProgressPhase(phase: AgentProgressPhase): phase is TerminalProgressPhase {
  return (TERMINAL_PROGRESS_PHASES as readonly string[]).includes(phase);
}

export const PROGRESS_STATUSES = ['started', 'updated', 'completed', 'failed'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
export const ProgressStatusSchema = z.enum(PROGRESS_STATUSES);

/**
 * Bounded label vocabulary. The client renders each code with fixed safe
 * text; unknown codes fall back to a generic message. No free-form text ever
 * crosses this boundary.
 */
export const PROGRESS_LABEL_CODES = [
  'request_accepted',
  'cache_checking',
  'cache_hit',
  'plan_ready',
  'search_running',
  'search_partial',
  'rerank_running',
  'sources_reading',
  'draft_ready',
  'verify_running',
  'save_done',
  'answer_complete',
  'degraded_partial',
  'request_cancelled',
  'heartbeat_running',
] as const;
export type ProgressLabelCode = (typeof PROGRESS_LABEL_CODES)[number];
export const ProgressLabelCodeSchema = z.enum(PROGRESS_LABEL_CODES);

const MAX_PROGRESS_ID_LENGTH = 100;
const MAX_PROGRESS_COUNTER = 9999;

export const AgentProgressEventSchema = z
  .object({
    id: z.string().min(1).max(MAX_PROGRESS_ID_LENGTH),
    phase: AgentProgressPhaseSchema,
    status: ProgressStatusSchema,
    labelCode: ProgressLabelCodeSchema,
    elapsedMs: z.number().int().min(0),
    callId: z.string().min(1).max(MAX_PROGRESS_ID_LENGTH).optional(),
    subquestionId: z.string().min(1).max(MAX_PROGRESS_ID_LENGTH).optional(),
    completed: z.number().int().min(0).max(MAX_PROGRESS_COUNTER).optional(),
    total: z.number().int().min(0).max(MAX_PROGRESS_COUNTER).optional(),
  })
  .strict()
  .refine((event) => event.completed === undefined || event.total === undefined || event.completed <= event.total, {
    message: 'completed must not exceed total',
  });
export type AgentProgressEvent = z.infer<typeof AgentProgressEventSchema>;

/** Fields that must never appear on a progress event, in any casing. */
export const FORBIDDEN_PROGRESS_FIELDS: readonly string[] = Object.freeze([
  'reasoning',
  'chainOfThought',
  'rationale',
  'query',
  'queryText',
  'rawQuery',
  'toolArgs',
  'toolArguments',
  'args',
  'providerError',
  'rawError',
  'errorDetail',
  'errorStack',
  'documentText',
  'chunkContent',
  'content',
  'ticket',
  'ticketBody',
  'email',
  'secret',
  'apiKey',
  'password',
  'token',
]);

const FORBIDDEN_PROGRESS_LOOKUP: ReadonlySet<string> = new Set(
  FORBIDDEN_PROGRESS_FIELDS.map((name) => name.toLowerCase()),
);

export function assertNoForbiddenProgressFields(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenProgressFields(entry);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PROGRESS_LOOKUP.has(key.toLowerCase())) {
      throw new Error(`assertNoForbiddenProgressFields: forbidden field ${key}`);
    }
    assertNoForbiddenProgressFields(entry);
  }
}

/**
 * Parses and freezes a progress event. Unknown/forbidden fields are rejected
 * by the strict schema, so reasoning, queries, tool args, provider errors,
 * document text, ticket data, and secrets cannot enter the stream.
 */
export function createProgressEvent(input: unknown): AgentProgressEvent {
  assertNoForbiddenProgressFields(input);
  const parsed = AgentProgressEventSchema.parse(input);
  return Object.freeze({ ...parsed });
}

export function isTerminalProgressEvent(event: AgentProgressEvent): boolean {
  return isTerminalProgressPhase(event.phase);
}

/** Deterministic serialization with fixed key order for size accounting. */
export function serializeProgressEvent(event: AgentProgressEvent): string {
  const ordered: Record<string, unknown> = {
    id: event.id,
    phase: event.phase,
    status: event.status,
    labelCode: event.labelCode,
    elapsedMs: event.elapsedMs,
  };
  if (event.callId !== undefined) ordered['callId'] = event.callId;
  if (event.subquestionId !== undefined) ordered['subquestionId'] = event.subquestionId;
  if (event.completed !== undefined) ordered['completed'] = event.completed;
  if (event.total !== undefined) ordered['total'] = event.total;
  return JSON.stringify(ordered);
}

export function serializedProgressSizeBytes(event: AgentProgressEvent | string): number {
  const text = typeof event === 'string' ? event : serializeProgressEvent(event);
  return new TextEncoder().encode(text).length;
}

/** p99 serialized progress payload must fit this budget (gate 12.5). */
export const MAX_PROGRESS_PAYLOAD_BYTES = 512 as const;

export function assertProgressPayloadWithinBudget(event: AgentProgressEvent): number {
  const size = serializedProgressSizeBytes(event);
  if (size > MAX_PROGRESS_PAYLOAD_BYTES) {
    throw new Error(
      `assertProgressPayloadWithinBudget: serialized progress event is ${size} bytes, budget is ${MAX_PROGRESS_PAYLOAD_BYTES}`,
    );
  }
  return size;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export interface ProgressPayloadStats {
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** p99 assertion helper over raw serialized sizes (core; testable). */
export function assertP99BytesWithinBudget(
  sizes: readonly number[],
  budgetBytes: number = MAX_PROGRESS_PAYLOAD_BYTES,
): ProgressPayloadStats {
  const sorted = [...sizes].sort((a, b) => a - b);
  const stats: ProgressPayloadStats = {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
  };
  if (stats.p99 > budgetBytes) {
    throw new Error(
      `assertP99BytesWithinBudget: p99 serialized payload is ${stats.p99} bytes over ${sorted.length} samples, budget is ${budgetBytes}`,
    );
  }
  return Object.freeze(stats);
}

/** p99 assertion helper for serialized progress payloads. */
export function assertP99ProgressPayloadWithinBudget(events: readonly AgentProgressEvent[]): ProgressPayloadStats {
  return assertP99BytesWithinBudget(events.map((event) => serializedProgressSizeBytes(event)));
}

export interface ProgressWirePart {
  readonly type: string;
  readonly data?: unknown;
}

/** Removes transient progress parts before history/model/cache persistence. */
export function stripProgressParts<TPart extends ProgressWirePart>(parts: readonly TPart[]): readonly TPart[] {
  return Object.freeze(parts.filter((part) => part.type !== PROGRESS_PART_TYPE));
}

function containsProgressMarker(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(PROGRESS_PART_TYPE);
  if (Array.isArray(value)) return value.some(containsProgressMarker);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => key === PROGRESS_PART_TYPE || containsProgressMarker(entry),
    );
  }
  return false;
}

/**
 * Pins the transience contract: no persisted history, model input, cached
 * answer, or grounding evidence payload may carry a progress part.
 */
export function assertProgressTransient(input: {
  readonly history: unknown;
  readonly modelMessages: unknown;
  readonly cachedAnswers: unknown;
  readonly evidence: unknown;
}): void {
  const entries = [
    ['history', input.history],
    ['modelMessages', input.modelMessages],
    ['cachedAnswers', input.cachedAnswers],
    ['evidence', input.evidence],
  ] as const;
  for (const [name, value] of entries) {
    if (containsProgressMarker(value)) {
      throw new Error(`assertProgressTransient: progress event leaked into ${name}`);
    }
  }
}
