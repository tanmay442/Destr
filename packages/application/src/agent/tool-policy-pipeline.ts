import type { z } from 'zod';
import type {
  AgentToolContext,
  AgentToolDefinition,
  ToolExecuteCall,
} from './tool-contract';
import { normalizeToolArgs } from './tool-approval';

export type ToolErrorKind = 'input_validation' | 'output_validation' | 'timeout' | 'cancelled' | 'denied' | 'budget_exceeded' | 'failed' | 'outcome_unknown';

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

const GENERIC_TOOL_ERROR_MESSAGE = 'Tool execution failed.';

const WRITE_RECONCILIATION_MAX_MS = 5_000;

function unknownWriteOutcomeError(toolName: string): ToolPolicyError {
  return new ToolPolicyError(
    'outcome_unknown',
    `${toolName} outcome is unknown; do not retry this request.`,
  );
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

function cancelledError(toolName: string, reason: unknown): ToolPolicyError {
  if (reason instanceof ToolPolicyError) return reason;
  return new ToolPolicyError(
    'cancelled',
    `${toolName} was cancelled.`,
    reason instanceof Error ? { cause: reason } : undefined,
  );
}

function throwIfAborted(signal: AbortSignal | undefined, toolName: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof ToolPolicyError) throw reason;
  throw new ToolPolicyError('cancelled', `${toolName} was cancelled.`, reason instanceof Error ? { cause: reason } : undefined);
}

interface LinkedAbortController {
  readonly signal: AbortSignal;
  abort(reason: unknown): void;
  cleanup(): void;
}

function linkAbortSignals(signals: readonly AbortSignal[]): LinkedAbortController {
  const controller = new AbortController();
  const uniqueSignals = [...new Set(signals)];
  const listeners = new Map<AbortSignal, () => void>();
  const onAbort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of uniqueSignals) {
    const listener = (): void => onAbort(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) onAbort(signal);
  }
  return {
    signal: controller.signal,
    abort(reason: unknown): void {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    cleanup(): void {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
      listeners.clear();
    },
  };
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  toolName: string,
  sourceSignals: readonly AbortSignal[],
  settleAfterAbort: boolean,
  reconcileBudgetMs?: number,
): Promise<T> {
  for (const signal of sourceSignals) throwIfAborted(signal, toolName);
  const linked = linkAbortSignals(sourceSignals);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationListener: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      cancellationListener = (): void => reject(cancelledError(toolName, linked.signal.reason));
      linked.signal.addEventListener('abort', cancellationListener, { once: true });
      if (linked.signal.aborted) cancellationListener();
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(toolName, ms);
        linked.abort(error);
        reject(error);
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const operationPromise = linked.signal.aborted
      ? Promise.reject<T>(cancelledError(toolName, linked.signal.reason))
      : operation(linked.signal);
    try {
      return await Promise.race([operationPromise, timeout, cancellation]);
    } catch (error) {
      if (!settleAfterAbort || !linked.signal.aborted) throw error;
      const cap = Math.min(
        WRITE_RECONCILIATION_MAX_MS,
        reconcileBudgetMs !== undefined ? Math.max(0, reconcileBudgetMs) : WRITE_RECONCILIATION_MAX_MS,
      );
      if (cap <= 0) {
        operationPromise.then(() => undefined, () => undefined);
        throw unknownWriteOutcomeError(toolName);
      }
      let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const reconcileTimeout = new Promise<never>((_, reject) => {
          reconcileTimer = setTimeout(() => reject(unknownWriteOutcomeError(toolName)), cap);
          if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
        });
        return await Promise.race([operationPromise, reconcileTimeout]);
      } catch (reconcileError) {
        operationPromise.then(() => undefined, () => undefined);
        if (reconcileError instanceof ToolPolicyError && reconcileError.kind === 'outcome_unknown') {
          throw reconcileError;
        }
        throw error;
      } finally {
        if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancellationListener !== undefined) linked.signal.removeEventListener('abort', cancellationListener);
    linked.cleanup();
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
    let terminalPhase: 'success' | 'error' | 'denied' | 'timeout' | 'cancelled' | null = null;
    context.trace.write({
      toolName: definition.name,
      callId: call.callId,
      phase: 'start',
      durationMs: null,
      sanitized: true,
    });
    const finish = (phase: 'success' | 'error' | 'denied' | 'timeout' | 'cancelled'): void => {
      if (terminalPhase !== null) return;
      terminalPhase = phase;
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
        const approvalInput = {
          toolName: definition.name,
          normalizedArgs: normalized,
          userId: context.actor.userId,
          turnId: context.turnId,
          nowMs: now(),
          ...(call.approvalToken !== undefined ? { approvalToken: call.approvalToken } : {}),
        };
        const approved =
          context.approvals.isExplicitlyRequested(approvalInput) ||
          (call.approvalToken !== undefined && context.approvals.isApproved(approvalInput));
        if (!approved) {
          finish('denied');
          throw new ToolPolicyError('denied', `${definition.name} requires explicit user intent or approval.`);
        }
      }
      counts.byTool.set(definition.name, currentForTool + 1);
      counts.total += 1;
      const reconcileBudgetMs = definition.policy.effect === 'write'
        ? Math.max(0, context.budget.deadlineAt - now())
        : undefined;
      const result = await withTimeout(
        (signal) => inner(parsedInput.data, {
          callId: call.callId,
          signal,
          ...(call.approvalToken !== undefined ? { approvalToken: call.approvalToken } : {}),
        }),
        definition.policy.timeoutMs,
        definition.name,
        [context.signal, call.signal],
        definition.policy.effect === 'write',
        reconcileBudgetMs,
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
        else if (error.kind === 'denied' || error.kind === 'budget_exceeded') finish('denied');
        else finish('error');
        throw error;
      }
      if (isAbortError(error) || context.signal.aborted || call.signal.aborted) {
        finish('cancelled');
        throw new ToolPolicyError('cancelled', sanitizeMessage(`${definition.name} was cancelled.`), { cause: error });
      }
      finish('error');
      throw new ToolPolicyError('failed', GENERIC_TOOL_ERROR_MESSAGE, { cause: error });
    }
  };
}

export function sanitizeToolError(error: unknown): { kind: ToolErrorKind; message: string } {
  if (error instanceof ToolPolicyError) {
    return {
      kind: error.kind,
      message: error.kind === 'failed' ? GENERIC_TOOL_ERROR_MESSAGE : sanitizeMessage(error.message),
    };
  }
  return { kind: 'failed', message: GENERIC_TOOL_ERROR_MESSAGE };
}
