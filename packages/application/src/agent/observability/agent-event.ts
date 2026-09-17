import { z } from 'zod';
import type { AgentStopReason } from '../agent-stop';

export { TOOL_CATALOG_VERSION } from '../tool-catalog';

export const EVENT_VERSION = 1 as const;

export const EventStatusSchema = z.enum([
  'started',
  'completed',
  'degraded',
  'failed',
  'cancelled',
  'denied',
]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

const AttributeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AttributeValue = z.infer<typeof AttributeValueSchema>;

const IsoDateTimeSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'startedAt must be an ISO-8601 date string',
  });

export const AgentEventEnvelopeSchema = z.object({
  eventVersion: z.literal(EVENT_VERSION),
  eventId: z.string().min(1).max(200),
  traceId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  startedAt: IsoDateTimeSchema,
  elapsedMs: z.number().int().min(0),
  status: EventStatusSchema,
  configurationFingerprint: z.string().min(1).max(200),
  agentBudgetVersion: z.string().min(1).max(200),
  toolCatalogVersion: z.string().min(1).max(200),
  deploymentVersion: z.string().min(1).max(200),
  region: z.string().min(1).max(100).optional(),
  attributes: z.record(z.string(), AttributeValueSchema),
});
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export const TURN_TERMINAL_STATES = [
  'answered_verified',
  'answered_qualified',
  'clarification_requested',
  'no_match',
  'approval_required',
  'ticket_created',
  'rejected_rate_limit',
  'rejected_capacity',
  'cancelled_by_user',
  'deadline_exhausted',
  'dependency_error',
  'internal_error',
] as const;
export const TurnTerminalStateSchema = z.enum(TURN_TERMINAL_STATES);
export type TurnTerminalState = z.infer<typeof TurnTerminalStateSchema>;

export const TokenFieldStatusSchema = z.enum(['reported', 'unsupported', 'missing', 'parse_error']);
export type TokenFieldStatus = z.infer<typeof TokenFieldStatusSchema>;

export const ReleasedOutputSchema = z.enum([
  'verified_answer',
  'qualified_answer',
  'withheld',
  'no_output',
]);
export type ReleasedOutput = z.infer<typeof ReleasedOutputSchema>;

export const PersistenceStatusSchema = z.enum(['persisted', 'durably_queued', 'failed', 'skipped']);
export type PersistenceStatus = z.infer<typeof PersistenceStatusSchema>;

export const GroundingDecisionSchema = z.enum(['verified', 'rejected', 'unverified']);
export type GroundingDecision = z.infer<typeof GroundingDecisionSchema>;

export const GroundingReasonSchema = z.enum([
  'unsupported_claim',
  'missing_citation',
  'timeout',
  'grader_unavailable',
  'malformed',
]);
export type GroundingReason = z.infer<typeof GroundingReasonSchema>;

export const StopReasonCodeSchema = z.enum([
  'completed',
  'max_model_steps',
  'max_total_tool_calls',
  'max_calls_for_tool',
  'max_search_calls',
  'max_search_plans',
  'max_physical_retrievals',
  'max_unique_evidence_chunks',
  'max_evidence_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'model_length',
  'model_content_filter',
  'model_error',
  'model_other',
  'duplicate_tool_call',
  'approval_interrupted',
  'deadline_exceeded',
  'timeout',
  'cancelled',
  'model_requested_stop',
  'schema_repair_exhausted',
  'no_tool_requested',
]);
export type StopReasonCode = z.infer<typeof StopReasonCodeSchema>;

const IdentifierSchema = z.string().min(1).max(200);

const provenanceShape = {
  callId: IdentifierSchema.optional(),
  subquestionId: IdentifierSchema.optional(),
  queryId: IdentifierSchema.optional(),
};

const budgetCounterShape = {
  modelStepsUsed: z.number().int().min(0).optional(),
  toolCallsUsed: z.number().int().min(0).optional(),
  searchCallsUsed: z.number().int().min(0).optional(),
  physicalRetrievalsUsed: z.number().int().min(0).optional(),
  uniqueEvidenceChunksUsed: z.number().int().min(0).optional(),
  evidenceTokensUsed: z.number().int().min(0).optional(),
};

const nullableTokenShape = {
  inputTokensTotal: z.number().int().min(0).nullable().optional(),
  cacheReadTokens: z.number().int().min(0).nullable().optional(),
  cacheWriteTokens: z.number().int().min(0).nullable().optional(),
  uncachedTokens: z.number().int().min(0).nullable().optional(),
  outputTokens: z.number().int().min(0).nullable().optional(),
  tokenStatus: TokenFieldStatusSchema.optional(),
};

const TurnReceivedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('turn.received'),
});

const TurnAdmissionSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('turn.admission'),
  admissionDecision: z.enum(['admitted', 'rejected_rate_limit', 'rejected_capacity']),
  reasonCode: z.string().min(1).max(200).optional(),
});

const TurnStartedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('turn.started'),
  agentProfileVersion: z.string().min(1).max(200).optional(),
});

const TurnTerminalSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('turn.terminal'),
  terminalState: TurnTerminalStateSchema,
  decisiveReason: z.string().min(1).max(200),
  releasedOutput: ReleasedOutputSchema,
  budgetConsumed: z.record(z.string(), z.number().int().min(0)).optional(),
  persistenceStatus: PersistenceStatusSchema,
  stopReasonCode: StopReasonCodeSchema.optional(),
});

const ModelStepStartedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('model.step.started'),
  stepNumber: z.number().int().min(1),
  ...provenanceShape,
  ...budgetCounterShape,
});

const ModelStepFirstTokenSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('model.step.first_token'),
  stepNumber: z.number().int().min(1),
  timeToFirstTokenMs: z.number().int().min(0),
});

const ModelStepCompletedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('model.step.completed'),
  stepNumber: z.number().int().min(1),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'error', 'other']),
  ...nullableTokenShape,
  ...budgetCounterShape,
});

const ToolAvailableSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('tool.available'),
  toolName: IdentifierSchema,
  toolVersion: z.string().min(1).max(200).optional(),
});

const ToolSelectedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('tool.selected'),
  toolName: IdentifierSchema,
  ...provenanceShape,
  reasonCode: z.string().min(1).max(200).optional(),
});

const ToolStartedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('tool.started'),
  toolName: IdentifierSchema,
  ...provenanceShape,
});

const ToolTerminalSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('tool.terminal'),
  toolName: IdentifierSchema,
  resultKind: z.enum(['success', 'no_match', 'degraded', 'error', 'timeout', 'cancelled', 'denied']),
  durationMs: z.number().int().min(0),
  reasonCode: z.string().min(1).max(200).optional(),
  ...provenanceShape,
  ...budgetCounterShape,
});

const SearchPlanSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('search.plan'),
  intent: z.enum(['documentation', 'out_of_scope', 'clarification_needed']),
  subquestionCount: z.number().int().min(0),
  variantCount: z.number().int().min(0),
  ...provenanceShape,
});

const SearchSubquestionSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('search.subquestion'),
  subquestionId: IdentifierSchema,
  executedQueryIds: z.array(IdentifierSchema).max(10),
  callId: provenanceShape.callId,
  queryId: provenanceShape.queryId,
});

const SearchRetrievalSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('search.retrieval'),
  modality: z.enum(['vector', 'lexical', 'batched']),
  candidateCount: z.number().int().min(0),
  status: z.enum(['completed', 'degraded', 'failed', 'cancelled']),
  reasonCode: z.string().min(1).max(200).optional(),
  ...provenanceShape,
  ...budgetCounterShape,
});

const SearchRerankSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('search.rerank'),
  finalSignal: z.enum(['dense', 'lexical', 'fusion', 'reranker']),
  rankedCount: z.number().int().min(0),
  fallbackUsed: z.boolean(),
  ...provenanceShape,
});

const EvidenceBackfillSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('evidence.backfill'),
  requestedNew: z.number().int().min(0),
  addedNew: z.number().int().min(0),
  reason: z.enum(['satisfied', 'pool_exhausted', 'relevance_floor', 'budget_exhausted']),
  ...provenanceShape,
});

const EvidencePackSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('evidence.pack'),
  uniqueChunks: z.number().int().min(0),
  evidenceTokens: z.number().int().min(0),
  truncatedBy: z
    .array(
      z.enum(['call_result_limit', 'subquestion_result_limit', 'turn_chunk_limit', 'turn_token_limit']),
    )
    .max(4),
  partial: z.boolean(),
  ...provenanceShape,
  ...budgetCounterShape,
});

const GroundingValidationSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('grounding.validation'),
  decision: GroundingDecisionSchema,
  reason: GroundingReasonSchema.optional(),
  citationCount: z.number().int().min(0).optional(),
});

export const AgentEventSchema = z.discriminatedUnion('eventType', [
  TurnReceivedSchema,
  TurnAdmissionSchema,
  TurnStartedSchema,
  TurnTerminalSchema,
  ModelStepStartedSchema,
  ModelStepFirstTokenSchema,
  ModelStepCompletedSchema,
  ToolAvailableSchema,
  ToolSelectedSchema,
  ToolStartedSchema,
  ToolTerminalSchema,
  SearchPlanSchema,
  SearchSubquestionSchema,
  SearchRetrievalSchema,
  SearchRerankSchema,
  EvidenceBackfillSchema,
  EvidencePackSchema,
  GroundingValidationSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type TurnTerminalEvent = Extract<AgentEvent, { eventType: 'turn.terminal' }>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreeze(entry);
    } else {
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

export function createEnvelope(input: unknown): AgentEventEnvelope {
  const parsed = AgentEventEnvelopeSchema.parse(input);
  return deepFreeze(parsed);
}

export function createEvent(input: unknown): AgentEvent {
  const parsed = AgentEventSchema.parse(input);
  return deepFreeze(parsed);
}

export function assertEventVersion(event: { readonly eventVersion: number }): void {
  if (event.eventVersion !== EVENT_VERSION) {
    throw new Error(
      `assertEventVersion: expected eventVersion ${EVENT_VERSION}, received ${event.eventVersion}`,
    );
  }
}

export function isTerminalEvent(event: Pick<AgentEvent, 'eventType'>): event is TurnTerminalEvent {
  return event.eventType === 'turn.terminal';
}

export function assertExactlyOneTerminal(events: readonly AgentEvent[]): TurnTerminalEvent {
  const terminals = events.filter(isTerminalEvent);
  if (terminals.length !== 1) {
    throw new Error(
      `assertExactlyOneTerminal: expected exactly one turn.terminal event, found ${terminals.length}`,
    );
  }
  const terminal = terminals[0];
  if (terminal === undefined) throw new Error('assertExactlyOneTerminal: terminal missing');
  return terminal;
}

export interface AgentEventContext {
  readonly traceId?: string | undefined;
  readonly configurationFingerprint?: string | undefined;
  readonly agentBudgetVersion?: string | undefined;
  readonly deploymentVersion?: string | undefined;
  readonly region?: string | undefined;
}

export function validateEventOrdering(events: readonly AgentEvent[]): void {  const byTurn = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const group = byTurn.get(event.turnId) ?? [];
    group.push(event);
    byTurn.set(event.turnId, group);
  }
  for (const [turnId, group] of byTurn) {
    const terminals = group.filter(isTerminalEvent);
    if (terminals.length === 0) continue;
    const starts = group.filter((event) => event.eventType === 'turn.started');
    if (starts.length === 0) {
      throw new Error(`validateEventOrdering: turn ${turnId} has a terminal event without turn.started`);
    }
    const earliestStart = Math.min(...starts.map((event) => Date.parse(event.startedAt)));
    for (const terminal of terminals) {
      if (Date.parse(terminal.startedAt) < earliestStart) {
        throw new Error(
          `validateEventOrdering: turn ${turnId} terminal predates turn.started`,
        );
      }
    }
  }
}

/**
 * Event-family scope (EVENT_VERSION 1, WP-7).
 *
 * Implemented: turn (received/admission/started/terminal), model.step
 * (started/first_token/completed), tool (available/selected/started/terminal),
 * search (plan/subquestion/retrieval/rerank), evidence (backfill/pack), and
 * grounding (validation) families. These cover the agent/tool/search/evidence
 * path measured by WP-7.
 *
 * Deferred to WP-8 (runtime/capacity scope): cache.*, progress.emitted,
 * stream.*, history.persist, event.persist, background.*, budget.*, and
 * dependency.* families. They describe the request path hardened in WP-8, not
 * the WP-7 evaluation seam. Adding a family does not change EVENT_VERSION
 * semantics for existing families; a breaking envelope change must bump
 * EVENT_VERSION and keep assertEventVersion green for the new version only.
 */

/**
 * Provisional loop-level mapping from an agent stop reason to the typed turn
 * terminal vocabulary (spec 7.3).
 *
 * The agent loop cannot know grounding, ticket persistence, admission, or
 * capacity outcomes; the chat-turn seam owns the authoritative turn.terminal
 * (verified/created/no_match/rate-limit states). This mapping is the loop's
 * best-known outcome so that every SupportAgent run still emits exactly one
 * terminal event: structural stops map exactly (approval/deadline/cancel),
 * model/dependency failures map to dependency_error with the stop code in
 * attributes, and candidate-producing runs map to answered_qualified
 * (verification pending at the turn seam, never verified by the loop). Budget
 * and duplicate stops also map to answered_qualified with the stop code in
 * attributes: the turn seam still releases a safe or qualified response, so
 * the run is qualified rather than failed. Whether candidate text exists is
 * carried in the terminal event's released-output field, not the state choice.
 */
export function mapAgentStopToTerminal(stop: AgentStopReason): TurnTerminalState {
  switch (stop.kind) {
    case 'approval_interrupted':
      return 'approval_required';
    case 'cancelled':
      return 'cancelled_by_user';
    case 'deadline_exceeded':
      return 'deadline_exhausted';
    case 'timeout':
    case 'model_length':
    case 'model_content_filter':
    case 'model_error':
    case 'model_other':
      return 'dependency_error';
    case 'completed':
    case 'no_tool_requested':
    case 'max_model_steps':
    case 'max_total_tool_calls':
    case 'max_calls_for_tool':
    case 'max_search_calls':
    case 'max_search_plans':
    case 'max_physical_retrievals':
    case 'max_unique_evidence_chunks':
    case 'max_evidence_tokens':
    case 'max_input_tokens':
    case 'max_output_tokens':
    case 'model_requested_stop':
    case 'schema_repair_exhausted':
    case 'duplicate_tool_call':
      return 'answered_qualified';
  }
}
