import { createHash } from 'node:crypto';

export type AgentStopReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max_model_steps'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_total_tool_calls'; readonly used: number; readonly limit: number }
  | {
      readonly kind: 'max_calls_for_tool';
      readonly toolName: string;
      readonly used: number;
      readonly limit: number;
    }
  | { readonly kind: 'max_search_calls'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_search_plans'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_physical_retrievals'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_unique_evidence_chunks'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_evidence_tokens'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_input_tokens'; readonly used: number; readonly limit: number }
  | { readonly kind: 'max_output_tokens'; readonly used: number; readonly limit: number }
  | { readonly kind: 'model_length' }
  | { readonly kind: 'model_content_filter' }
  | { readonly kind: 'model_error' }
  | { readonly kind: 'model_other' }
  | { readonly kind: 'duplicate_tool_call'; readonly toolName: string; readonly normalizedArgs: string }
  | { readonly kind: 'approval_interrupted'; readonly toolName: string; readonly callId: string }
  | { readonly kind: 'deadline_exceeded'; readonly nowMs: number; readonly deadlineAt: number }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'model_requested_stop' }
  | { readonly kind: 'schema_repair_exhausted'; readonly toolName: string }
  | { readonly kind: 'no_tool_requested' };

export type AgentStopKind = AgentStopReason['kind'];

export interface SeenToolCall {
  readonly toolName: string;
  readonly normalizedArgsHash: string;
}

export function detectDuplicateCall(
  seen: readonly SeenToolCall[],
  candidate: SeenToolCall,
): boolean {
  return seen.some(
    (entry) =>
      entry.toolName === candidate.toolName &&
      entry.normalizedArgsHash === candidate.normalizedArgsHash,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.trim());
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value).trim());
}

export function normalizeArgsHash(args: unknown): string {
  return createHash('sha256').update(stableJson(args), 'utf8').digest('hex');
}

// Highest priority first. schema_repair_exhausted groups with the other
// per-tool ceilings; no_tool_requested groups with model behavior stops.
const priorityKinds: AgentStopKind[] = [
  'cancelled',
  'deadline_exceeded',
  'timeout',
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
  'schema_repair_exhausted',
  'duplicate_tool_call',
  'approval_interrupted',
  'no_tool_requested',
  'model_requested_stop',
  'completed',
];

export const STOP_PRIORITY: readonly AgentStopKind[] = Object.freeze(priorityKinds);

function priorityOf(kind: AgentStopKind): number {
  const index = STOP_PRIORITY.indexOf(kind);
  return index === -1 ? STOP_PRIORITY.length : index;
}

export function pickEarliestStop(
  reasons: readonly [AgentStopReason, ...AgentStopReason[]],
): AgentStopReason {
  let best: AgentStopReason = reasons[0];
  for (const reason of reasons) {
    if (priorityOf(reason.kind) < priorityOf(best.kind)) best = reason;
  }
  return best;
}
