import type { z } from 'zod';
import type {
  AgentToolContext,
  AgentToolDefinition,
  ToolExecuteCall,
} from './tool-contract';
import { normalizeToolArgs } from './tool-approval';

export type ToolErrorKind = 'input_validation' | 'output_validation' | 'timeout' | 'cancelled' | 'denied' | 'budget_exceeded' | 'failed';

export class ToolPolicyError extends Error {
  readonly kind: ToolErrorKind;
  constructor(kind: ToolErrorKind, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ToolPolicyError';
    this.kind = kind;
  }
}

function sanitizeMessage(message: string): string {
  return message.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Tool execution failed.';
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message);
  }
  return false;
}

function timeoutError(toolName: string, timeoutMs: number): ToolPolicyError {
  return new ToolPolicyError('timeout', `${toolName} timed out after ${timeoutMs}ms.`);
}

function throwIfAborted(signal: AbortSignal | undefined, toolName: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof ToolPolicyError) throw reason;
  throw new ToolPolicyError('cancelled', `${toolName} was cancelled.`, reason instanceof Error ? { cause: reason } : undefined);
}

async function withTimeout<T>(operation: Promise<T>, ms: number, toolName: string, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal, toolName);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(toolName, ms)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const abort = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new ToolPolicyError('cancelled', `${toolName} was cancelled.`));
        return;
      }
      const onAbort = (): void => {
        reject(new ToolPolicyError('cancelled', `${toolName} was cancelled.`, signal.reason instanceof Error ? { cause: signal.reason } : undefined));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation, timeout, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PolicyCounts {
  total: number;
  byTool: Map<string, number>;
}

export function createPolicyCounts(): PolicyCounts {
  return { total: 0, byTool: new Map() };
}

export function wrapToolWithPolicy<TInput, TOutput>(input: {
  definition: AgentToolDefinition<TInput, TOutput>;
  context: AgentToolContext;
  inner: (parsed: TInput, call: ToolExecuteCall) => Promise<TOutput>;
  counts: PolicyCounts;
  now?: () => number;
}): (rawInput: unknown, call: ToolExecuteCall) => Promise<TOutput> {
  const { definition, context, inner, counts } = input;
  const now = input.now ?? Date.now;
  return async (rawInput: unknown, call: ToolExecuteCall): Promise<TOutput> => {
    const startedAt = now();
    context.trace.write({
      toolName: definition.name,
      callId: call.callId,
      phase: 'start',
      durationMs: null,
      sanitized: true,
    });
    const finish = (phase: 'success' | 'error' | 'denied' | 'timeout' | 'cancelled'): void => {
      context.trace.write({
        toolName: definition.name,
        callId: call.callId,
        phase,
        durationMs: Math.max(0, now() - startedAt),
        sanitized: true,
      });
    };
    try {
      throwIfAborted(context.signal, definition.name);
      throwIfAborted(call.signal, definition.name);
      const parsedInput = definition.inputSchema.safeParse(rawInput);
      if (!parsedInput.success) {
        const first = parsedInput.error.issues[0];
        const message = first ? `${String(first.path.join('.') || 'input')}: ${first.message}` : 'Invalid tool input.';
        finish('error');
        throw new ToolPolicyError('input_validation', sanitizeMessage(message));
      }
      const currentForTool = counts.byTool.get(definition.name) ?? 0;
      const configuredMax = context.budget.maxCallsByTool[definition.name] ?? definition.policy.maxCallsPerTurn;
      if (currentForTool >= definition.policy.maxCallsPerTurn || currentForTool >= configuredMax) {
        finish('denied');
        throw new ToolPolicyError('budget_exceeded', `${definition.name} call limit reached for this turn.`);
      }
      if (counts.total >= context.budget.maxTotalToolCalls) {
        finish('denied');
        throw new ToolPolicyError('budget_exceeded', 'Total tool call limit reached for this turn.');
      }
      if (now() > context.budget.deadlineAt) {
        finish('timeout');
        throw new ToolPolicyError('timeout', `${definition.name} skipped: turn deadline exceeded.`);
      }
      if (definition.policy.effect === 'write' && definition.policy.requiresApproval) {
        const normalized = normalizeToolArgs(parsedInput.data);
        const approved =
          context.approvals.isExplicitlyRequested() ||
          context.approvals.isApproved({
            toolName: definition.name,
            normalizedArgs: normalized,
            userId: context.actor.userId,
            turnId: context.turnId,
            nowMs: now(),
          });
        if (!approved) {
          finish('denied');
          throw new ToolPolicyError('denied', `${definition.name} requires explicit user intent or approval.`);
        }
      }
      counts.byTool.set(definition.name, currentForTool + 1);
      counts.total += 1;
      const combinedSignal = anySignal([context.signal, call.signal]);
      const result = await withTimeout(
        inner(parsedInput.data, { callId: call.callId, signal: combinedSignal }),
        definition.policy.timeoutMs,
        definition.name,
        combinedSignal,
      );
      const parsedOutput = (definition.outputSchema as z.ZodType<TOutput>).safeParse(result);
      if (!parsedOutput.success) {
        finish('error');
        throw new ToolPolicyError('output_validation', sanitizeMessage('Tool returned an invalid result shape.'));
      }
      finish('success');
      return parsedOutput.data;
    } catch (error) {
      if (error instanceof ToolPolicyError) {
        if (error.kind === 'timeout') finish('timeout');
        else if (error.kind === 'cancelled') finish('cancelled');
        throw error;
      }
      if (isAbortError(error) || context.signal.aborted || call.signal.aborted) {
        finish('cancelled');
        throw new ToolPolicyError('cancelled', sanitizeMessage(`${definition.name} was cancelled.`), { cause: error });
      }
      finish('error');
      throw new ToolPolicyError('failed', sanitizeMessage(error instanceof Error ? error.message : 'Tool execution failed.'), { cause: error });
    }
  };
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const active = signals.filter((signal) => !signal.aborted);
  if (active.length === 0) return signals[0] as AbortSignal;
  if (active.length === 1) return active[0] as AbortSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function sanitizeToolError(error: unknown): { kind: ToolErrorKind; message: string } {
  if (error instanceof ToolPolicyError) return { kind: error.kind, message: sanitizeMessage(error.message) };
  if (error instanceof Error) return { kind: 'failed', message: sanitizeMessage(error.message) };
  return { kind: 'failed', message: 'Tool execution failed.' };
}
