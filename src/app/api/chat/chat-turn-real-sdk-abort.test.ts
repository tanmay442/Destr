import { describe, expect, it } from 'vitest';
import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
} from 'ai';
import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { appConfigSchema, ok } from '@app/domain';
import {
  chatTurn,
  type ChatModelUsageTelemetry,
  type ChatTurnDeps,
  type ChatTurnRequest,
} from '@app/application/chat';

const REQUEST_BODY = {
  turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAbortBeforeStepModel(started: { resolve(): void }): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'abort-before-step',
    supportedUrls: {},
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      throw new Error('doGenerate is not used by this regression test');
    },
    doStream: async ({ abortSignal }): Promise<LanguageModelV3StreamResult> => {
      started.resolve();
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          const closeOnAbort = () => controller.close();
          if (abortSignal?.aborted) {
            closeOnAbort();
          } else {
            abortSignal?.addEventListener('abort', closeOnAbort, { once: true });
          }
        },
      });
      return { stream };
    },
  };
}

function makeRequest(signal: AbortSignal): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(REQUEST_BODY),
    signal,
  });
}

async function consume(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // Drain the stream so chatTurn's post-generation work runs.
  }
}

function usageTelemetry(): ChatModelUsageTelemetry {
  return {
    inputTokens: null,
    inputTokensStatus: 'unsupported',
    cachedInputTokens: null,
    cachedInputTokensStatus: 'unsupported',
    cacheReadTokens: null,
    cacheReadStatus: 'unsupported',
    cacheWriteTokens: null,
    cacheWriteStatus: 'unsupported',
    cacheHitRatio: null,
  };
}

describe('chatTurn real AI SDK abort handling', () => {
  it('does not leak providerMetadata rejection when aborting before the first step', async () => {
    const cfg = appConfigSchema.parse({
      retrievalMode: 'normal',
      retrievalModeRolloutPercent: 100,
      answerCacheEnabled: false,
      captureQueryText: false,
      hallucinationCheckEnabled: false,
    });
    const streamStarted = deferred<void>();
    const requestController = new AbortController();
    const parseUsageCalls: unknown[][] = [];
    const model = createAbortBeforeStepModel({ resolve: () => streamStarted.resolve() });
    const deps: ChatTurnDeps = {
      ai: { convertToModelMessages, createUIMessageStream, stepCountIs, streamText, tool },
      getChatModel: () => model,
      getChatModelId: () => model.modelId,
      getEmbeddingModelId: () => 'test-embedding',
      getRuntimeConfig: async () => cfg,
      searchChunks: async () => ok([]),
      agenticSearch: async () => ok({
        chunks: [],
        rewrittenQuery: '',
        outOfDomain: false,
        isEmpty: true,
        fallbackReason: null,
        resultState: 'empty',
      }),
      hallucinationGrader: () => null,
      answerCache: {
        get: async () => null,
        set: async () => undefined,
      },
      answerCacheKey: () => 'unused',
      rateLimit: {
        check: async () => ({ ok: true, remaining: 1, resetMs: 60_000 }),
      },
      createTicket: async () => ok({ ticketId: 'unused', status: 'created' }),
      userResolver: async () => ({ userId: 'user_test' }),
      eventSink: {
        record: () => undefined,
        flush: async () => undefined,
      },
      getChatModelRequestOptions: () => ({
        providerOptions: {},
        parseUsage: (...args: unknown[]) => {
          parseUsageCalls.push(args);
          return usageTelemetry();
        },
      }),
      traceEnabled: false,
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.prependListener('unhandledRejection', onUnhandledRejection);
    try {
      const result = await chatTurn(
        { request: makeRequest(requestController.signal), userId: 'user_test' } satisfies ChatTurnRequest,
        deps,
      );
      expect(result.kind).toBe('stream');
      if (result.kind !== 'stream') return;

      await streamStarted.promise;
      requestController.abort(new DOMException('aborted before first step', 'TimeoutError'));
      await consume(result.stream);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(parseUsageCalls).toHaveLength(1);
      expect(parseUsageCalls[0]?.[1]).toBeUndefined();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });
});
