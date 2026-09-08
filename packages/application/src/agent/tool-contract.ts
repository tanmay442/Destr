import type { z } from 'zod';

export type ToolEffect = 'read' | 'write';

export interface ToolGuidance {
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly resultSemantics: readonly string[];
}

export interface ToolPolicy {
  readonly effect: ToolEffect;
  readonly idempotent: boolean;
  readonly requiresApproval: boolean;
  readonly maxCallsPerTurn: number;
  readonly timeoutMs: number;
}

export interface AgentRunBudget {
  readonly deadlineAt: number;
  readonly maxTotalToolCalls: number;
  readonly maxCallsByTool: Readonly<Record<string, number>>;
}

export function createDefaultBudget(input: {
  nowMs?: number;
  maxTotalToolCalls?: number;
  maxCallsByTool?: Readonly<Record<string, number>>;
  deadlineInMs?: number;
}): AgentRunBudget {
  const now = input.nowMs ?? Date.now();
  return {
    deadlineAt: now + (input.deadlineInMs ?? 50_000),
    maxTotalToolCalls: input.maxTotalToolCalls ?? 10,
    maxCallsByTool: input.maxCallsByTool ?? {},
  };
}

export interface GroundingEvidenceCollector {
  readonly seenChunkKeys: ReadonlySet<string>;
  addEvidence(chunks: readonly EvidenceChunk[]): readonly EvidenceChunk[];
}

export interface EvidenceChunk {
  readonly content: string;
  readonly source: string | null;
}

export type ToolTracePhase = 'start' | 'success' | 'error' | 'denied' | 'timeout' | 'cancelled';

export interface ToolTraceEvent {
  readonly toolName: string;
  readonly callId: string;
  readonly phase: ToolTracePhase;
  readonly durationMs: number | null;
  readonly sanitized: boolean;
}

export interface AgentTraceWriter {
  write(event: ToolTraceEvent): void;
  readonly events: readonly ToolTraceEvent[];
}

export function createInMemoryTraceWriter(): AgentTraceWriter & { readonly collected: ToolTraceEvent[] } {
  const collected: ToolTraceEvent[] = [];
  return {
    get events(): readonly ToolTraceEvent[] {
      return collected;
    },
    get collected(): ToolTraceEvent[] {
      return collected;
    },
    write(event: ToolTraceEvent): void {
      collected.push({ ...event, sanitized: true });
    },
  };
}

export interface ApprovalCheckInput {
  readonly toolName: string;
  readonly normalizedArgs: string;
  readonly userId: string;
  readonly turnId: string;
  readonly nowMs: number;
  /**
   * Issued approvals are bearer credentials.  A matching scope without the
   * credential must never authorize a write.
   */
  readonly approvalToken?: string;
}

export interface ApprovalIssueInput {
  readonly toolName: string;
  readonly normalizedArgs: string;
  readonly userId: string;
  readonly turnId: string;
  readonly ttlMs: number;
  readonly nowMs: number;
}

export interface ToolApprovalPolicy {
  isExplicitlyRequested(input: ApprovalCheckInput): boolean;
  isApproved(input: ApprovalCheckInput): boolean;
  issueApproval(input: ApprovalIssueInput): { readonly token: string; readonly expiresAt: number };
}

export interface AgentToolContext {
  readonly actor: { readonly userId: string };
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly budget: AgentRunBudget;
  readonly evidence: GroundingEvidenceCollector;
  readonly trace: AgentTraceWriter;
  readonly approvals: ToolApprovalPolicy;
}

export interface ToolExecuteCall {
  readonly callId: string;
  readonly signal: AbortSignal;
  /** Optional approval credential presented for this exact tool invocation. */
  readonly approvalToken?: string;
}

export interface AgentToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly inputExamples: readonly TInput[];
  readonly guidance: ToolGuidance;
  readonly policy: ToolPolicy;
  create(context: AgentToolContext): (input: TInput, call: ToolExecuteCall) => Promise<TOutput>;
}
