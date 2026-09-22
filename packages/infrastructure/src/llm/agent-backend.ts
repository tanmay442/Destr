import { generateText, isStepCount, tool } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider';
import type { PromptCacheUsage } from './prompt-cache';

/**
 * Define an input-only model tool from catalog metadata. The tool carries
 * the real validation schema for the model but no `execute` function, so
 * the SDK returns tool calls without executing them; execution stays in the
 * application tool catalog (single policy implementation). Provider option
 * keys never leave this adapter.
 */
export function defineAgentModelTool(input: {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly inputExamples?: readonly { readonly input: unknown }[] | undefined;
  readonly strict?: boolean | undefined;
}): unknown {
  if (typeof input.inputSchema !== 'object' || input.inputSchema === null) {
    throw new Error('defineAgentModelTool requires a schema object.');
  }
  return tool({
    description: input.description,
    inputSchema: input.inputSchema as never,
    ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema as never } : {}),
    ...(input.inputExamples !== undefined ? { inputExamples: [...input.inputExamples] } : {}),
    ...(input.strict !== undefined ? { strict: input.strict } : {}),
  });
}

export type AgentBackendMessagePart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      readonly url: string;
      readonly mediaType: string;
      readonly filename?: string | undefined;
    };

export interface AgentBackendMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly text: string;
  readonly parts?: readonly AgentBackendMessagePart[] | undefined;
}

export interface AgentBackendStep {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly cacheStatus: 'reported' | 'unsupported' | 'missing';
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other';
}

export interface AgentBackendToolMap {
  readonly [toolName: string]: unknown;
}

export function createAgentModelBackend(input: {
  readonly model: LanguageModelV4;
  readonly tools: AgentBackendToolMap;
  readonly providerOptions?: SharedV4ProviderOptions | undefined;
  readonly parseUsage?: ((usage: unknown, providerMetadata?: unknown) => PromptCacheUsage) | undefined;
  readonly maxOutputTokens?: number | undefined;
}): {
  generateStep(step: {
    readonly system: string;
    readonly messages: readonly AgentBackendMessage[];
    readonly activeTools: Readonly<Record<string, { readonly description: string; readonly inputSchemaJson: unknown }>>;
    readonly toolChoice: 'auto' | 'none' | { readonly tool: string };
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number | undefined;
  }): Promise<AgentBackendStep>;
} {
  return {
    async generateStep(step): Promise<AgentBackendStep> {
      if (step.signal.aborted) {
        throw new DOMException('Model step was cancelled.', 'AbortError');
      }
      if (!(step.timeoutMs > 0)) {
        throw timeoutError(step.timeoutMs);
      }
      const timeoutController = new AbortController();
      const onAbort = (): void => timeoutController.abort(step.signal.reason);
      step.signal.addEventListener('abort', onAbort, { once: true });
      const timeoutId = setTimeout(() => {
        timeoutController.abort(timeoutError(step.timeoutMs));
      }, step.timeoutMs);
      if (typeof timeoutId.unref === 'function') timeoutId.unref();
      const activeNames = new Set(Object.keys(step.activeTools));
      const tools: ToolSet = {};
      for (const [name, bound] of Object.entries(input.tools)) {
        if (activeNames.has(name)) tools[name] = bound as ToolSet[string];
      }
      try {
        const maxOutputTokens = step.maxOutputTokens ?? input.maxOutputTokens;
        const result = await generateText({
          model: input.model,
          instructions: step.system,
          messages: step.messages.map(toModelMessage),
          tools: tools as ToolSet,
          toolChoice: toToolChoice(step.toolChoice),
          stopWhen: isStepCount(1),
          abortSignal: timeoutController.signal,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        });
        if (step.signal.aborted) {
          throw new DOMException('Model step was cancelled.', 'AbortError');
        }
        // The application backend represents exactly one provider step. AI SDK 7
        // aggregates several result fields at the top level, so read the explicit
        // final-step view to preserve the pre-migration contract.
        return toBackendStep(result.finalStep, input.parseUsage);
      } catch (error) {
        if (step.signal.aborted || isAbortError(error)) {
          throw new DOMException('Model step was cancelled.', 'AbortError');
        }
        if (timeoutController.signal.aborted && !step.signal.aborted) {
          throw timeoutError(step.timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        step.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function toModelMessage(message: AgentBackendMessage): ModelMessage {
  if (message.role === 'system') {
    return { role: 'system', content: message.text };
  }
  const content = message.parts !== undefined && message.parts.length > 0
    ? message.parts.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : {
          type: 'file' as const,
          data: new URL(part.url),
          mediaType: part.mediaType,
          ...(part.filename !== undefined ? { filename: part.filename } : {}),
        })
    : message.text;
  if (message.role === 'user') return { role: 'user', content };
  return { role: 'assistant', content };
}

function toToolChoice(
  choice: 'auto' | 'none' | { readonly tool: string },
): 'auto' | 'none' | { readonly type: 'tool'; readonly toolName: string } {
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'tool', toolName: choice.tool };
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Model step timed out after ${Math.max(0, timeoutMs)}ms.`);
  error.name = 'TimeoutError';
  return error;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message);
  }
  return false;
}

function nonnegativeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function toBackendStep(
  result: {
    readonly text: string;
    readonly toolCalls: readonly {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: unknown;
    }[];
    readonly usage?: unknown;
    readonly providerMetadata?: unknown;
    readonly finishReason?: unknown;
  },
  parseUsage?: ((usage: unknown, providerMetadata?: unknown) => PromptCacheUsage) | undefined,
): AgentBackendStep {
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let cacheStatus: AgentBackendStep['cacheStatus'] = 'missing';
  if (parseUsage) {
    try {
      const parsed = parseUsage(result.usage, result.providerMetadata);
      cacheReadTokens = parsed.cacheReadTokens;
      cacheWriteTokens = parsed.cacheWriteTokens;
      const readReported = parsed.cacheReadStatus === 'reported';
      const writeReported = parsed.cacheWriteStatus === 'reported';
      const readUnsupported = parsed.cacheReadStatus === 'unsupported';
      const writeUnsupported = parsed.cacheWriteStatus === 'unsupported';
      if (readReported || writeReported) cacheStatus = 'reported';
      else if (readUnsupported && writeUnsupported) cacheStatus = 'unsupported';
      else cacheStatus = 'missing';
    } catch {
      cacheStatus = 'missing';
    }
  }
  const finishReason = result.finishReason;
  return {
    text: result.text,
    toolCalls: result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.input,
    })),
    inputTokens: nonnegativeOrNull(usage['inputTokens']),
    outputTokens: nonnegativeOrNull(usage['outputTokens']),
    cacheReadTokens,
    cacheWriteTokens,
    cacheStatus,
    finishReason:
      finishReason === 'tool-calls'
        ? 'tool_calls'
        : finishReason === 'length'
          ? 'length'
          : finishReason === 'content-filter'
            ? 'content_filter'
            : finishReason === 'error'
              ? 'error'
              : finishReason === 'other'
                ? 'other'
                : 'stop',
  };
}
