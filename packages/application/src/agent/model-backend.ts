/**
 * Neutral single-step model port for the project-owned support agent loop.
 *
 * Provider-neutral by construction: no vendor imports, no streaming, no
 * multi-step orchestration. The loop in support-agent.ts owns step policy;
 * this backend answers exactly one model step per call.
 *
 * Abort and timeout contract (both MUST be honored by every implementation):
 * - signal abortion: when the provided AbortSignal aborts (before or during
 *   the call), reject with a DOMException named 'AbortError'.
 * - timeoutMs: when the model step does not settle within timeoutMs, reject
 *   with an Error whose `name` is 'TimeoutError'.
 * The loop maps AbortError -> cancelled and TimeoutError -> timeout stops.
 */

export type AgentModelMessagePart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      readonly url: string;
      readonly mediaType: string;
      readonly filename?: string | undefined;
    };

export interface AgentModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly text: string;
  readonly parts?: readonly AgentModelMessagePart[] | undefined;
}

export interface AgentModelToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface AgentModelStepResult {
  readonly text: string;
  readonly toolCalls: readonly AgentModelToolCall[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly cacheStatus: 'reported' | 'unsupported' | 'missing';
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other';
}

export interface AgentModelBackendTool {
  readonly description: string;
  /**
   * Opaque JSON-schema placeholder (a plain JSON value such as
   * `{ description: '...' }` or `{}`). Never a zod object: zod schemas
   * carry methods and closures, so passing them here would leak the
   * framework's validation library into provider adapters.
   */
  readonly inputSchemaJson: unknown;
}

export interface AgentModelBackend {
  generateStep(input: {
    readonly system: string;
    readonly messages: readonly AgentModelMessage[];
    readonly activeTools: Readonly<Record<string, AgentModelBackendTool>>;
    readonly toolChoice: 'auto' | 'none' | { readonly tool: string };
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number | undefined;
  }): Promise<AgentModelStepResult>;
}
