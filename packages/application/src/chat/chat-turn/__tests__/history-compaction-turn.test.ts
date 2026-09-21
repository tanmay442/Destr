import { describe, expect, it, vi } from 'vitest';
import { ok } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk, RetrievalDiagnostics } from '../../../rag/search';
import { chatTurn } from '../turn';
import type { ChatTurnDeps, ChatTurnResult } from '../turn-types';
import {
  compactHistoryForModel,
  estimateMessageTokens,
} from '../../history-compaction';
import {
  compactModelHistory,
  toChatUIMessages,
  type ChatInputMessage,
} from '../../message-types';
import {
  createScriptedBackend,
  type ScriptedStep,
} from '../../../agent/scripted-model';
import type { AgentModelBackend as BackendPort } from '../../../agent/model-backend';
import type { ChatChunk } from '../../chat-chunks';

/**
 * E1 history-compaction turn wiring.
 *
 * Pins the two-stage turn contract: compactModelHistory runs FIRST for
 * character/message-bounded UI shaping (newest-win, 24 msgs / 50k chars),
 * then compactHistoryForModel applies the token budget
 * (maxInputTokens 12_000 starting value, recentMessagesToKeep 8,
 * currentRequestId = last user message id or null). The turn feeds that
 * compacted list into the unchanged currentMessage/agentHistory split.
 */

const CHUNK: RetrievedChunk = {
  id: 1,
  documentId: 10,
  fileName: 'benefits.pdf',
  page: 3,
  sectionTitle: 'Dental',
  source: 'https://example.com/benefits.pdf',
  title: 'Benefits',
  content: 'The dental plan covers two cleanings per year.',
  chunkIndex: 0,
  scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' },
};

function testDiagnostics(finalCount: number): RetrievalDiagnostics {
  return {
    requestedLimit: finalCount,
    candidateLimit: finalCount,
    documentFilterApplied: false,
    dense: { status: 'ok', candidateCount: finalCount },
    lexical: { status: 'not_run', candidateCount: 0, mode: 'weighted_websearch' },
    fusion: { applied: false, inputCount: finalCount, outputCount: finalCount },
    reranker: {
      status: 'not_configured', inputCount: 0, validCount: 0, acceptedCount: 0,
      threshold: null, thresholdFilteredCount: 0,
    },
    resolutionMode: 'parent',
    resolvedCount: finalCount,
    stableDuplicatesSkipped: 0,
    backfillCount: 0,
    hasMore: false,
    finalCount,
    finalRanks: Array.from({ length: finalCount }, (_, index) => index + 1),
  };
}

function makeCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    orgName: 'Test Corp',
    audience: 'test customers',
    agentPersona: { name: 'Destr', tone: 'friendly' },
    outOfScopeTopics: [],
    customInstructions: undefined,
    retrievalMode: 'normal',
    retrievalModeRolloutPercent: 100,
    agentStepBudget: 8,
    similarityThreshold: 0.5,
    hybridEnabled: true,
    hallucinationCheckEnabled: true,
    judgeSampleRate: 0,
    rerankerProvider: 'cosine',
    auxModel: undefined,
    answerCacheEnabled: true,
    answerCacheTtlSec: 3600,
    captureQueryText: true,
    prefetchFirstTurn: false,
    ...overrides,
  } as AppConfig;
}

function makeDepsWithBackend(
  backend: BackendPort & { readonly calls: readonly { readonly messages: readonly { readonly text: string }[] }[] },
): { deps: ChatTurnDeps; appendTurn: ReturnType<typeof vi.fn> } {
  const cfg = makeCfg();
  const appendTurn = vi.fn(async () => ({ conversationId: 'conv-1' }));
  const deps: ChatTurnDeps = {
    modelGateway: {
      createStream: ({ execute }: { execute: (writer: { write: (chunk: ChatChunk) => void }) => void }) =>
        new ReadableStream<ChatChunk>({
          start(controller) {
            const chunks: ChatChunk[] = [];
            execute({ write: (chunk) => chunks.push(chunk) });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      defineTool: (opts: unknown) => opts,
      createModelBackend: () => backend,
    } as unknown as ChatTurnDeps['modelGateway'],
    getChatModel: () => ({ modelId: 'test-chat' }),
    getChatModelId: () => 'test-chat',
    getEmbeddingModelId: () => 'emb-3',
    getRuntimeConfig: async () => cfg,
    getModelToolCapabilities: () => ({
      strictSchemas: 'native',
      inputExamples: 'native',
      outputSchemas: 'validated_locally',
      parallelCalls: true,
      toolCallRepair: 'unsupported',
      approvalHooks: 'application',
    }),
    searchChunks: (async () => ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) })) as ChatTurnDeps['searchChunks'],
    hallucinationGrader: () => null,
    answerCache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    } as unknown as ChatTurnDeps['answerCache'],
    answerCacheKey: () => 'rag:answer:test-key',
    rateLimit: { check: vi.fn(async () => ({ ok: true as const, remaining: 29, resetMs: 60_000 })) },
    createTicket: (async () => {
      throw new Error('unused');
    }) as unknown as ChatTurnDeps['createTicket'],
    userResolver: (async () => ({ userId: 'user_test' })) as unknown as ChatTurnDeps['userResolver'],
    eventSink: { record: vi.fn(), flush: vi.fn(async () => undefined) },
    historySink: { appendTurn } as unknown as NonNullable<ChatTurnDeps['historySink']>,
    traceEnabled: false,
  };
  return { deps, appendTurn };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readAll(stream: ReadableStream<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } catch {
    // Stream errors still deliver preceding chunks first.
  }
  return out;
}

const CURRENT_MARKER = 'current-request-marker-zzz';
// 2_600 chars/message (~655 tokens): the shaped suffix holds 19 messages
// (~49.8k char cap) totalling ~12.5k tokens, over the 12k turn budget, so
// the token stage deterministically compacts by dropping the oldest
// unprotected message(s) while keeping current + recent.
const PAD = 'x'.repeat(2_600);

function longHistoryInput(): ChatInputMessage[] {
  // 31 messages ending in a user message so the current request is last.
  // Each message carries ~2.6k chars (~655 tokens): the shaped suffix holds
  // 19 newest messages (~49.8k char cap, ~12.5k tokens), forcing the 12k token
  // stage to truncate while preserving current + recent.
  return Array.from({ length: 31 }, (_, index): ChatInputMessage => {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const text = index === 30
      ? `${CURRENT_MARKER} what is the dental coverage? ${PAD}`
      : `history-marker-${index}| ${PAD}`;
    return { id: `m${index}`, role, parts: [{ type: 'text', text }] };
  });
}

function turnCompactionOptions(currentRequestId: string | null) {
  return {
    maxInputTokens: 12_000,
    recentMessagesToKeep: 8,
    currentRequestId,
    approvalContextIds: [],
    constraintMessageIds: [],
  };
}

describe('history compaction turn wiring (E1)', () => {
  it('truncates a long history to the token budget while preserving the current request and recent window', async () => {
    const inputMessages = longHistoryInput();
    const backend = createScriptedBackend([{ text: 'Hello world' }] as readonly ScriptedStep[]);
    const { deps } = makeDepsWithBackend(backend as unknown as BackendPort & { readonly calls: readonly { readonly messages: readonly { readonly text: string }[] }[] });
    const result: ChatTurnResult = await chatTurn(
      {
        request: makeRequest({
          turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          messages: inputMessages,
        }),
        userId: 'user_test',
      },
      deps,
    );
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readAll(result.stream);
    expect(backend.calls.length).toBeGreaterThan(0);
    const modelMessages = backend.calls[0]!.messages;
    const texts = modelMessages.map((message) => message.text);

    // Truncation happened: the model sees strictly fewer messages than sent.
    expect(modelMessages.length).toBeLessThan(inputMessages.length);

    // Current request preserved: the last user message reaches the model.
    expect(texts.some((text) => text.includes(CURRENT_MARKER))).toBe(true);
    expect(texts[texts.length - 1]).toContain(CURRENT_MARKER);

    // Recent window preserved: recompute the turn's two stages locally with
    // the turn's exact options and require the same recent suffix.
    const uiMessages = toChatUIMessages(inputMessages);
    const shaped = compactModelHistory(uiMessages);
    const lastUserId = [...shaped].reverse().find((message) => message.role === 'user')?.id ?? null;
    const { messages: expected, result: compaction } = compactHistoryForModel(shaped, turnCompactionOptions(lastUserId));
    expect(['compacted', 'over_budget']).toContain(compaction.outcome);
    expect(compaction.preservedCurrentRequestId).toBe(lastUserId);
    const recentIds = shaped.slice(Math.max(0, shaped.length - 8)).map((message) => message.id);
    for (const id of recentIds) {
      expect(compaction.keptMessageIds).toContain(id);
    }
    // The turn feeds exactly this compacted list into the split: backend
    // message count equals the compacted history length.
    expect(modelMessages.length).toBe(expected.length);
    // Token budget holds unless the protected set alone exceeds it (the
    // module guarantees the current request is still kept).
    if (compaction.outcome === 'compacted') {
      expect(compaction.afterTokens).toBeLessThanOrEqual(12_000);
    } else {
      expect(compaction.keptMessageIds).toContain(lastUserId);
    }
  });

  it('leaves tiny histories unchanged', async () => {
    const inputMessages: ChatInputMessage[] = [
      { id: 't0', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 't1', role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
      { id: 't2', role: 'user', parts: [{ type: 'text', text: 'how do I reset my password?' }] },
    ];
    const backend = createScriptedBackend([{ text: 'Reset it in settings.' }] as readonly ScriptedStep[]);
    const { deps } = makeDepsWithBackend(backend as unknown as BackendPort & { readonly calls: readonly { readonly messages: readonly { readonly text: string }[] }[] });
    const result: ChatTurnResult = await chatTurn(
      {
        request: makeRequest({
          turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          messages: inputMessages,
        }),
        userId: 'user_test',
      },
      deps,
    );
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readAll(result.stream);
    const modelMessages = backend.calls[0]!.messages;
    // No truncation: history (2) + current (1) all reach the model in order.
    expect(modelMessages.length).toBe(3);
    expect(modelMessages[0]!.text).toContain('hello');
    expect(modelMessages[2]!.text).toContain('how do I reset my password?');

    // Unit pin: the same tiny history is unchanged under the turn's options.
    const uiMessages = toChatUIMessages(inputMessages);
    const shaped = compactModelHistory(uiMessages);
    const lastUserId = [...shaped].reverse().find((message) => message.role === 'user')?.id ?? null;
    const { messages: kept, result: compaction } = compactHistoryForModel(shaped, turnCompactionOptions(lastUserId));
    expect(compaction.outcome).toBe('unchanged');
    expect(kept.map((message) => message.id)).toEqual(shaped.map((message) => message.id));
  });

  it('preserves approval context, constraints, and recent messages under the turn budget shape', () => {
    const uiMessages = toChatUIMessages(
      Array.from({ length: 10 }, (_, index): ChatInputMessage => ({
        id: `m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: 'x'.repeat(40) }],
      })),
    );
    const shaped = compactModelHistory(uiMessages);
    const lastUserId = [...shaped].reverse().find((message) => message.role === 'user')?.id ?? null;
    const { messages: kept, result } = compactHistoryForModel(shaped, {
      ...turnCompactionOptions(lastUserId),
      // 90 protected tokens (recent-8 window m2..m9 plus approval m1 on
      // 10-token messages): 95 compacts by dropping only the oldest
      // unprotected message instead of going over budget.
      maxInputTokens: 95,
      approvalContextIds: ['m1'],
      constraintMessageIds: ['m2'],
    });
    expect(result.outcome).toBe('compacted');
    expect(kept.map((message) => message.id)).toContain('m1');
    expect(kept.map((message) => message.id)).toContain('m2');
    expect(kept.map((message) => message.id)).toContain(lastUserId);
    expect(result.afterTokens).toBeLessThanOrEqual(95);
    // No invented content: every kept id is an input id in input order.
    const inputIds = new Set(shaped.map((message) => message.id));
    for (const id of result.keptMessageIds) expect(inputIds.has(id)).toBe(true);
  });

  it('keeps the current request even when the protected set alone exceeds the budget', () => {
    const uiMessages = toChatUIMessages(longHistoryInput());
    const shaped = compactModelHistory(uiMessages);
    const lastUserId = [...shaped].reverse().find((message) => message.role === 'user')?.id ?? null;
    const { messages: kept, result } = compactHistoryForModel(shaped, turnCompactionOptions(lastUserId));
    // With the 12k starting budget this history compacts (not over budget);
    // force the over-budget path with a tiny budget to pin the guarantee the
    // turn relies on when it proceeds with the protected set.
    expect(result.outcome === 'compacted' || result.outcome === 'over_budget').toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    const tiny = compactHistoryForModel(shaped, { ...turnCompactionOptions(lastUserId), maxInputTokens: 15 });
    expect(tiny.result.outcome).toBe('over_budget');
    expect(tiny.messages.map((message) => message.id)).toContain(lastUserId);
    // Token accounting is deterministic: afterTokens equals the summed
    // per-message estimates of the kept set.
    const recomputed = tiny.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    expect(tiny.result.afterTokens).toBe(recomputed);
  });
});
