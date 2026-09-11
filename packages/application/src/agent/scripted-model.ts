/**
 * Deterministic scripted backend for support-agent tests.
 *
 * Returns queued steps in order and records every call (system, messages,
 * visible active-tool keys, toolChoice) for assertions about which tools
 * were visible at each step. After the queue is exhausted, generateStep
 * throws Error('script exhausted') deterministically instead of repeating.
 */
import type { AgentModelBackend, AgentModelMessage, AgentModelStepResult } from './model-backend';

export interface ScriptedToolCall {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ScriptedStep {
  readonly text?: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly cacheStatus?: 'reported' | 'unsupported' | 'missing';
  readonly finishReason?: AgentModelStepResult['finishReason'];
  readonly error?: 'abort' | 'timeout' | 'fail';
}

export interface ScriptedBackendCall {
  readonly system: string;
  readonly messages: readonly AgentModelMessage[];
  readonly activeTools: readonly string[];
  readonly toolChoice: 'auto' | 'none' | { readonly tool: string };
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function timeoutError(): Error {
  const error = new Error('Scripted model timeout.');
  error.name = 'TimeoutError';
  return error;
}

export function createScriptedBackend(
  steps: readonly ScriptedStep[],
): AgentModelBackend & { readonly calls: readonly ScriptedBackendCall[] } {
  const calls: ScriptedBackendCall[] = [];
  let stepIndex = 0;
  let callCounter = 0;

  return {
    get calls(): readonly ScriptedBackendCall[] {
      return calls;
    },
    async generateStep(input: {
      readonly system: string;
      readonly messages: readonly AgentModelMessage[];
      readonly activeTools: Readonly<Record<string, { readonly description: string; readonly inputSchemaJson: unknown }>>;
      readonly toolChoice: 'auto' | 'none' | { readonly tool: string };
      readonly signal: AbortSignal;
      readonly timeoutMs: number;
      readonly maxOutputTokens?: number | undefined;
    }): Promise<AgentModelStepResult> {
      calls.push(
        Object.freeze({
          system: input.system,
          messages: Object.freeze([...input.messages]),
          activeTools: Object.freeze(Object.keys(input.activeTools)),
          toolChoice: input.toolChoice,
        }),
      );
      if (input.signal.aborted) throw abortError();
      const step = steps[stepIndex];
      if (step === undefined) throw new Error('script exhausted');
      stepIndex += 1;
      if (step.error === 'abort') throw abortError();
      if (step.error === 'timeout') throw timeoutError();
      if (step.error === 'fail') throw new Error('scripted failure');
      const toolCalls = (step.toolCalls ?? []).map((call) => {
        callCounter += 1;
        return Object.freeze({
          toolCallId: call.toolCallId ?? `call-${callCounter}`,
          toolName: call.toolName,
          args: call.args,
        });
      });
      return Object.freeze({
        text: step.text ?? '',
        toolCalls: Object.freeze(toolCalls),
        inputTokens: step.inputTokens ?? 10,
        outputTokens: step.outputTokens ?? 5,
        cacheReadTokens: step.cacheReadTokens ?? null,
        cacheWriteTokens: step.cacheWriteTokens ?? null,
        cacheStatus: step.cacheStatus ?? 'unsupported',
        finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      });
    },
  };
}
