import { randomUUID } from 'node:crypto';
import type { ChatChunk, ChatStreamWriter } from '../chat-chunks';
import {
  CHAT_RATE_LIMIT,
  logger,
  MAX_DURATION_MS,
  TURN_DEADLINE_BANNER_MESSAGE,
  TURN_DEADLINE_TEXT,
  type AgenticResultState,
  type ChatEventInput,
} from '@app/domain';
import {
  buildStableSystemPrompt,
  buildSystemPrompt,
  SYSTEM_PROMPT_PREFIX_VERSION,
} from '../../prompt/build-system-prompt';
import { SearchFailure } from '../../rag/search';
import {
  cacheFingerprint,
  legacySearchResultCacheFingerprint,
  SEARCH_RESULT_CONTRACT_VERSION,
} from '../cache-key';
import { buildEventMeta } from '../build-event-meta';
import { shouldCache } from '../should-cache';
import { buildAssistantMessageLike } from '../history';
import { dedupeCitations } from '../dedupe-citations';
import { citationDocumentIds } from '../emit-citations';
import { addGroundingEvidence, createGroundingEvidence } from '../grounding-evidence';
import { createChatRequestSchema } from '../request-schema';
import { resolveTurnId } from '../turn-id';
import {
  compactModelHistory,
  toChatUIMessages,
  type ChatInputMessage,
  type ChatUIMessage,
} from '../message-types';
import type { AgentModelMessage, AgentModelMessagePart } from '../../agent/model-backend';
import {
  createCacheLease,
  waitForCachedAnswer,
  type CacheLease,
  type CacheLeaseOptions,
  type CacheLeaseTelemetry,
} from '../cache-lease';
import {
  legacyTurnRequestFingerprint,
  turnRequestFingerprint,
  TURN_FINGERPRINT_VERSION,
} from '../turn-fingerprint';
import { parseCachedAnswer, parseTurnResult, createCachedAnswerStream, TURN_RESULT_CACHE_TTL_SEC } from './cached-answer';

/**
 * Adapt one compat-wrapped tool envelope to the catalog instance shape the
 * SupportAgent loop drives. Execution stays inside the request-scoped envelope.
 */
function toAgentToolInstance(name: string, envelope: CatalogCompatToolEnvelope): BuiltToolInstance {
  return {
    name,
    description: envelope.description,
    inputSchema: envelope.inputSchema,
    outputSchema: envelope.outputSchema,
    inputExamples: undefined,
    strict: undefined,
    execute: (rawInput, call) => envelope.execute(rawInput, {
      toolCallId: call.callId,
      abortSignal: call.signal,
      ...(call.approvalToken !== undefined ? { approvalToken: call.approvalToken } : {}),
      ...(envelope.internalToolContext !== undefined
        ? { experimental_context: envelope.internalToolContext }
        : {}),
    }),
    policyEffect: name === TICKET_TOOL_NAME ? 'write' : 'read',
  };
}
import { persistHistory, readBoundedJson } from './turn-io';
import {
  buildCatalogToolsForTurn,
  type CatalogCompatToolEnvelope,
  type PrefetchedSearchOutcome,
} from '../../agent/compat/chat-tools-compat';
import { createAgentRunBudget } from '../../agent/agent-budget';
import { createSupportAgent, SEARCH_TOOL_NAME, TICKET_TOOL_NAME } from '../../agent/support-agent';
import { DEFAULT_TOOL_CAPABILITIES } from '../../agent/model-tool-capabilities';
import { readSupportAgentFlag } from '../../agent/agent-flags';
import { createApprovalPolicyForTurn } from '../../agent/tool-approval';
import type { BuiltToolInstance, ToolCatalog } from '../../agent/tool-catalog';
import { readPlannerFlags } from '../../agent/search/search-flags';
import { estimateChunkTokens } from '../../agent/search/evidence-packer';
import { TurnToolLedger } from '../../agent/run-state';
import { DEFAULT_TURN_SOFT_DEADLINE_MS, DEFAULT_JUDGE_MAX_WALL_MS } from './hallucination';
import type { ChatTurnDeps, ChatTurnRequest, ChatTurnResult, ChatModelUsageTelemetry, TurnMetrics } from './turn-types';
import { validateCitations } from '../../agent/grounding/citation-validator';
import { assembleGroundingInput } from '../../agent/grounding/grounding-evidence-input';
import { runGroundingCheck } from '../../agent/grounding/grounding-check';
import { readGroundedReleaseFlag } from '../../agent/grounding/grounding-flags';
import { GROUNDING_TRACE_VERSION, toLogFields } from '../../agent/grounding/grounding-telemetry';
import { safeResponseFor } from '../../agent/grounding/safe-response';
import { serializeUntrustedChunk } from '../../agent/prompt/serialize-untrusted-result';
import type { GroundingCitation, GroundingDecision } from '../../agent/grounding/grounding-decision';

function physicalRetrievalsFromDiagnostics(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key of ['dense', 'lexical']) {
    const stage = record[key];
    if (typeof stage !== 'object' || stage === null) continue;
    const status = (stage as Record<string, unknown>).status;
    if (typeof status === 'string' && status !== 'not_run') count += 1;
  }
  return count;
}

function toAgentModelMessage(message: ChatUIMessage): AgentModelMessage {
  const parts: AgentModelMessagePart[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'file') {
      parts.push({
        type: 'file',
        url: part.url,
        mediaType: part.mediaType,
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
      });
    }
  }
  return {
    role: message.role,
    text: parts.filter((part): part is Extract<AgentModelMessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\\n'),
    parts,
  };
}

function successfulAgentStop(kind: string): boolean {
  return kind === 'completed' || kind === 'no_tool_requested';
}

function fallbackTextForAgentStop(kind: string): string {
  if (kind === 'approval_interrupted') return 'I need your confirmation before I can create a knowledge ticket.';
  if (kind === 'model_content_filter') return 'I could not provide a response for this request.';
  return 'I could not finish this response within the request limits. Please try again.';
}

// Upper bound for one grounding-grader call. The effective timeout is the
// smaller of this cap and the remaining turn work budget, so verification
// can never borrow the mandatory finalization reserve (WP-5 seam).
const GROUNDING_GRADER_TIMEOUT_MS = 10_000;

export async function chatTurn(input: ChatTurnRequest, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const turnStart = input.startedAt ?? performance.now();
  const requestStartedAt = Date.now();
  const { request, userId } = input;
  const cfg = await deps.getRuntimeConfig();
  const limit = await deps.rateLimit.check(`chat:${userId}`, CHAT_RATE_LIMIT, request.signal);
  if (request.signal.aborted) throw new DOMException('Chat rate limit check was cancelled.', 'AbortError');
  if (!limit.ok) {
    return {
      kind: 'rate-limited',
      retryAfterSec: Number.isFinite(limit.retryAfterMs)
        ? String(Math.ceil(limit.retryAfterMs / 1000))
        : undefined,
    };
  }

  const body = await readBoundedJson(request);
  if (body.tooLarge) {
    return { kind: 'payload-too-large' };
  }
  const raw = body.value;
  const parsed = createChatRequestSchema(deps.allowedChatFileOrigins).safeParse(raw);
  if (!parsed.success) {
    return { kind: 'invalid-request', issues: parsed.error.issues };
  }
  const inputMessages: ChatInputMessage[] = parsed.data.messages;
  const messages = toChatUIMessages(inputMessages);
  const lastUserMessage = [...inputMessages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUserMessage
    ? lastUserMessage.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
    : '';

  const groundingEvidence = createGroundingEvidence();
  const capturedCitations = groundingEvidence.citations;

  const turnId = resolveTurnId(parsed.data.turnId);
  const turnRequestHash = {
    current: turnRequestFingerprint({
      conversationId: parsed.data.conversationId,
      retry: parsed.data.retry,
      semanticContext: cacheFingerprint(cfg, cfg.retrievalMode),
      messages: inputMessages,
    }),
    preResultContract: turnRequestFingerprint({
      conversationId: parsed.data.conversationId,
      retry: parsed.data.retry,
      semanticContext: legacySearchResultCacheFingerprint(cfg, cfg.retrievalMode),
      messages: inputMessages,
    }),
    legacy: legacyTurnRequestFingerprint({
      conversationId: parsed.data.conversationId,
      messages: inputMessages,
    }),
  };

  const isFirstTurn = messages.length <= 1;

  const useConfiguredMode = Math.random() * 100 < cfg.retrievalModeRolloutPercent;
  let effectiveMode: 'agentic' | 'normal' = useConfiguredMode
    ? cfg.retrievalMode
    : cfg.retrievalMode === 'agentic'
      ? 'normal'
      : 'agentic';
  if (process.env.AGENTIC_ENABLED === 'false') effectiveMode = 'normal';

  const persistedMode: ChatEventInput['mode'] = effectiveMode === 'normal' ? 'vector' : 'agentic';
  const queryText = cfg.captureQueryText ? lastUserText || null : null;
  const metrics: TurnMetrics = {
    retrieveMs: 0,
    prefetchMs: null,
    prefetchStatus: 'disabled',
    firstTokenMs: null,
    hallucinationMs: null,
    hitCount: null,
    maxRetrievalScores: {},
    searchResultStates: [],
    ticketCreated: false,
    ticketId: null,
    rewritten: false,
    reformulationCount: 0,
  };

  const cacheable = cfg.answerCacheEnabled && isFirstTurn && lastUserText.trim() !== '';
  const cacheKey = cacheable
      ? deps.answerCacheKey(lastUserText, {
        embeddingModel: deps.getEmbeddingModelId(),
        chatModel: deps.getChatModelId(),
        userId,
        fingerprint: cacheFingerprint(cfg, effectiveMode),
      })
    : null;
  const turnResultCache = deps.turnResultCache;
  const turnResultCoordinationKey = turnResultCache && turnId
    ? `rag:turn-result:${encodeURIComponent(userId)}:${turnId}`
    : null;
  const turnResultKey = turnResultCoordinationKey
    ? `rag:turn-result:v${SEARCH_RESULT_CONTRACT_VERSION}:${encodeURIComponent(userId)}:${turnId}`
    : null;
  let cacheLease: CacheLease | null = null;
  let turnLease: CacheLease | null = null;
  const releaseLeases = async (): Promise<void> => {
    const leases = [cacheLease, turnLease].filter((lease): lease is CacheLease => lease !== null);
    cacheLease = null;
    turnLease = null;
    const results = await Promise.all(leases.map((lease) => lease.releaseResult()));
    for (const result of results) {
      if (result.kind === 'unavailable') {
        logger.warn('chat.cache.lease_release_unavailable', { turnId });
      }
    }
  };
  let leasesEscaped = false;
  const cacheLeaseOptions: CacheLeaseOptions = {
    policy: deps.cacheLeasePolicy ?? 'degraded',
    onTelemetry: deps.onCacheLeaseTelemetry ?? ((event: CacheLeaseTelemetry): void => {
      logger.warn('chat.cache.lease_coordination', {
        operation: event.operation,
        result: event.result,
        policy: event.policy,
      });
    }),
  };

  try {
    if (turnResultCache && turnResultKey && turnResultCoordinationKey) {
      const readTurnState = async () => {
        const current = await turnResultCache.get(turnResultKey).catch(() => null);
        const currentState = current ? parseTurnResult(current, turnRequestHash) : null;
        // Fail closed: only verified grounded outcomes replay. Marked
        // non-verified entries are never written, and legacy unmarked
        // entries predate release gating, so both are treated as a miss.
        if (currentState && 'answer' in currentState && currentState.answer.grounding?.kind !== 'verified') {
          return null;
        }
        if (currentState) return currentState;
        const compatible = await turnResultCache.get(turnResultCoordinationKey).catch(() => null);
        const compatibleState = compatible ? parseTurnResult(compatible, turnRequestHash) : null;
        if (compatibleState && 'answer' in compatibleState && compatibleState.answer.grounding?.kind !== 'verified') {
          return null;
        }
        return compatibleState;
      };
      let turnState = await readTurnState();
      if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
      if (!turnState) {
        const lease = createCacheLease(
          turnResultCache,
          turnResultCoordinationKey,
          Math.ceil(MAX_DURATION_MS / 1000),
          cacheLeaseOptions,
        );
        const leaseResult = await lease.acquireResult();
        if (leaseResult.kind === 'acquired') {
          turnLease = lease;
          turnState = await readTurnState();
          if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
        } else if (leaseResult.kind === 'held') {
          const remainingWaitMs = Math.max(
            0,
            MAX_DURATION_MS - (Date.now() - requestStartedAt) - 5_000,
          );
          await waitForCachedAnswer(turnResultCache, turnResultCoordinationKey, {
            timeoutMs: remainingWaitMs,
            signal: request.signal,
          });
          turnState = await readTurnState();
          if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
          if (!turnState) return { kind: 'cache-wait-timeout' };
        } else {
          return { kind: 'cache-unavailable' };
        }
      }
      if (turnState && 'answer' in turnState) {
        const cachedAnswer = turnState.answer;
        deps.eventSink.record({
          turnId,
          userId,
          query: queryText,
          mode: persistedMode,
          cacheHit: true,
          totalMs: Math.round(performance.now() - turnStart),
          ...(cachedAnswer.citations.length > 0
            ? { citationCount: cachedAnswer.citations.length }
            : {}),
          ...(cachedAnswer.citations.length > 0 || cachedAnswer.search
            ? {
                meta: buildEventMeta({
                  documentIds: citationDocumentIds(cachedAnswer.citations),
                  searchResultStates: cachedAnswer.search?.resultStates,
                  retrievalScoreMaxima: cachedAnswer.search?.scoreMaxima,
                }),
              }
            : {}),
        });
        const historyPersisted = await persistHistory(deps.historySink, cfg, userId, {
          conversationId: parsed.data.conversationId,
          turnId,
          retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
          title: lastUserText,
          userMessage: lastUserMessage,
          assistantMessage: buildAssistantMessageLike({
            turnId,
            text: cachedAnswer.text,
            citations: dedupeCitations(cachedAnswer.citations),
            guardrail: cachedAnswer.guardrail ?? null,
          }),
        });
        await releaseLeases();
        const stream = createCachedAnswerStream(
          deps.modelGateway,
          cachedAnswer,
          historyPersisted,
          parsed.data.conversationId,
        );
        leasesEscaped = true;
        return {
          kind: 'stream',
          stream,
          meta: { turnId, mode: persistedMode, cacheHit: true },
        };
      }
    }

    if (cacheKey) {
    if (deps.traceEnabled) logger.info('rag.cache.get', { key: cacheKey });
    let cached = await deps.answerCache.get(cacheKey).catch(() => null);
    if (!cached) {
      const lease = createCacheLease(
        deps.answerCache,
        cacheKey,
        Math.ceil(MAX_DURATION_MS / 1000),
        cacheLeaseOptions,
      );
      const leaseResult = await lease.acquireResult();
      if (leaseResult.kind === 'acquired') {
        cacheLease = lease;
        cached = await deps.answerCache.get(cacheKey).catch(() => null);
      } else if (leaseResult.kind === 'held') {
        const remainingWaitMs = Math.max(
          0,
          MAX_DURATION_MS - (Date.now() - requestStartedAt) - 5_000,
        );
        cached = await waitForCachedAnswer(deps.answerCache, cacheKey, {
          timeoutMs: remainingWaitMs,
          signal: request.signal,
        });
        if (!cached) return { kind: 'cache-wait-timeout' };
      } else {
        return { kind: 'cache-unavailable' };
      }
    }
    if (cached) {
      if (deps.traceEnabled) logger.info('rag.cache.hit', { key: cacheKey });
      const cachedAnswer = parseCachedAnswer(cached);
      if (cachedAnswer.grounding?.kind !== 'verified') {
        // Fail closed: only verified grounded answers replay from the
        // answer cache. Legacy unmarked entries predate release gating and
        // any non-verified marker must never replay as an answer.
        if (deps.traceEnabled) logger.info('rag.cache.unverified_skip', { key: cacheKey });
        cached = null;
      }
    }
    if (cached) {
      if (deps.traceEnabled) logger.info('rag.cache.replay', { key: cacheKey });
      const cachedAnswer = parseCachedAnswer(cached);
      deps.eventSink.record({
        turnId,
        userId,
        query: queryText,
        mode: persistedMode,
        cacheHit: true,
        totalMs: Math.round(performance.now() - turnStart),
        ...(cachedAnswer.citations.length > 0
          ? { citationCount: cachedAnswer.citations.length }
          : {}),
        ...(cachedAnswer.citations.length > 0 || cachedAnswer.search
          ? {
              meta: buildEventMeta({
                documentIds: citationDocumentIds(cachedAnswer.citations),
                searchResultStates: cachedAnswer.search?.resultStates,
                retrievalScoreMaxima: cachedAnswer.search?.scoreMaxima,
              }),
            }
          : {}),
      });
      const historyPersisted = await persistHistory(deps.historySink, cfg, userId, {
        conversationId: parsed.data.conversationId,
        turnId,
        retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
        title: lastUserText,
        userMessage: lastUserMessage,
        assistantMessage: buildAssistantMessageLike({
          turnId,
          text: cachedAnswer.text,
          citations: dedupeCitations(cachedAnswer.citations),
          guardrail: null,
        }),
      });
      await releaseLeases();
      const stream = deps.modelGateway.createStream({
        execute: (writer: ChatStreamWriter) => {
          writer.write({ type: 'text-start', id: 'cached' });
          writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
          writer.write({ type: 'text-end', id: 'cached' });
          for (const src of dedupeCitations(cachedAnswer.citations)) {
            writer.write({
              type: 'data-citation',
              data: src,
            });
          }
          if (historyPersisted && parsed.data.conversationId) {
            writer.write({
              type: 'data-conversation-persisted',
              data: { conversationId: parsed.data.conversationId },
            });
          }
        },
      });
      leasesEscaped = true;
      return {
        kind: 'stream',
        stream,
        meta: { turnId, mode: persistedMode, cacheHit: true },
      };
    }
    if (deps.traceEnabled) logger.info('rag.cache.miss', { key: cacheKey });
    }

  const prefetchedToolState = {
    outOfDomain: false,
    isEmpty: false,
    resultState: null as AgenticResultState | null,
  };
  const toolLedger = new TurnToolLedger();

  // One turn wall-clock deadline shared by prefetch, tools, and the model
  // loop. Created before prefetch so prefetch cannot escape the turn
  // envelope. Full deadline-ledger accounting remains WP-8 scope.
  const rawSoftDeadlineMs = deps.turnSoftDeadlineMs ?? DEFAULT_TURN_SOFT_DEADLINE_MS;
  const maxSoftDeadlineMs = MAX_DURATION_MS - 5_000;
  let softDeadlineMs = rawSoftDeadlineMs;
  if (softDeadlineMs > maxSoftDeadlineMs) {
    logger.warn('CHAT_SOFT_DEADLINE_MS clamped', { requested: rawSoftDeadlineMs, clamped: maxSoftDeadlineMs });
    softDeadlineMs = maxSoftDeadlineMs;
  }
  const judgeMaxWallMs = deps.judgeMaxWallMs ?? DEFAULT_JUDGE_MAX_WALL_MS;
  const agentFlag = readSupportAgentFlag({ get: (key: string) => process.env[key] });
  const agentBudget = createAgentRunBudget({
    nowMs: requestStartedAt,
    deadlineInMs: softDeadlineMs,
    finalizeReserveMs: Math.min(15_000, softDeadlineMs),
    overrides: {
      maxModelSteps: effectiveMode === 'agentic' ? cfg.agentStepBudget : 5,
      ...(agentFlag.enabled ? {} : { maxModelSteps: 1 }),
    },
  });
  const workDeadlineAt = agentBudget.deadlineAt - agentBudget.finalizeReserveMs;
  // The turn signal stops model and tool work before the finalization reserve;
  // persistence, lease release, and stream closure keep the remaining budget.
  const softDeadlineMsForPrefetch = Math.max(0, workDeadlineAt - Date.now());
  const softDeadlineSignal = AbortSignal.timeout(softDeadlineMsForPrefetch);
  let softDeadlineFired = false;
  softDeadlineSignal.addEventListener('abort', () => {
    softDeadlineFired = true;
  });
  const turnSignal = AbortSignal.any([request.signal, softDeadlineSignal]);
  let prefetch: PrefetchedSearchOutcome | null = null;
  const plannerPrefetchBypass = deps.structuredSearch !== undefined &&
    readPlannerFlags({ get: (key: string) => process.env[key] }).plannerEnabled;
  if (cfg.prefetchFirstTurn && !plannerPrefetchBypass && isFirstTurn && lastUserText.trim() !== '') {
    const prefetchStartedAt = performance.now();
    if (request.signal.aborted) throw new DOMException('Chat turn was cancelled.', 'AbortError');
    const prefetchResult = turnSignal.aborted
      ? {
          ok: false as const,
          error: new SearchFailure('timeout', true, 'Documentation prefetch exceeded the turn deadline.'),
        }
      : await deps.searchChunks(cfg, lastUserText, { signal: turnSignal });
    metrics.prefetchMs = Math.round(performance.now() - prefetchStartedAt);
    metrics.retrieveMs += metrics.prefetchMs;
    metrics.prefetchStatus = 'performed';
    if (!prefetchResult.ok) {
      logger.error('First-turn pre-fetch failed', { code: prefetchResult.error.code });
      prefetch = {
        kind: 'error',
        query: lastUserText,
        failure: prefetchResult.error,
        usage: { plansUsed: 0, physicalRetrievalsUsed: 0, uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 },
      };
      metrics.searchResultStates.push('error');
      prefetchedToolState.resultState = 'error';
    } else {
      const { chunks, degradedBy } = prefetchResult.value;
      for (const chunk of prefetchResult.value.chunks) {
        for (const signal of ['dense', 'lexical', 'fusion', 'reranker'] as const) {
          const score = chunk.scores[signal];
          const previous = metrics.maxRetrievalScores[signal];
          if (score !== undefined && (previous === undefined || score > previous)) {
            metrics.maxRetrievalScores[signal] = score;
          }
        }
      }
      if (chunks.length === 0 && degradedBy.length > 0) {
        const code = degradedBy.every((item) => item === 'reranker_unavailable')
          ? 'reranker_unavailable'
          : 'retrieval_unavailable';
        prefetch = {
          kind: 'error',
          query: lastUserText,
          failure: new SearchFailure(
            code,
            true,
            'The documentation search is temporarily unavailable. Please try again.',
          ),
          usage: {
            plansUsed: 0,
            physicalRetrievalsUsed: physicalRetrievalsFromDiagnostics(prefetchResult.value.diagnostics),
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
          },
        };
        metrics.searchResultStates.push('error');
        prefetchedToolState.resultState = 'error';
        metrics.hitCount = 0;
      } else if (chunks.length === 0) {
        prefetch = {
          kind: 'no_match',
          query: lastUserText,
          usage: {
            plansUsed: 0,
            physicalRetrievalsUsed: physicalRetrievalsFromDiagnostics(prefetchResult.value.diagnostics),
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
          },
        };
        metrics.searchResultStates.push('no_match');
        prefetchedToolState.resultState = 'no_match';
        prefetchedToolState.outOfDomain = true;
        prefetchedToolState.isEmpty = true;
        metrics.hitCount = 0;
      } else {
        const matches = addGroundingEvidence(groundingEvidence, chunks);
        prefetch = {
          kind: 'results',
          query: lastUserText,
          matches,
          degradedBy,
          usage: {
            plansUsed: 0,
            physicalRetrievalsUsed: physicalRetrievalsFromDiagnostics(prefetchResult.value.diagnostics),
            uniqueEvidenceAdded: matches.length,
            evidenceTokensAdded: matches.reduce((total, chunk) => total + estimateChunkTokens(chunk), 0),
          },
        };
        const state: AgenticResultState = degradedBy.length > 0 ? 'degraded' : 'results';
        metrics.searchResultStates.push(state);
        prefetchedToolState.resultState = state;
        metrics.hitCount = matches.length;
      }
    }
  }

  const modelRequestOptions = deps.getChatModelRequestOptions?.({
    stablePromptPrefix: buildStableSystemPrompt(cfg),
    prefixVersion: SYSTEM_PROMPT_PREFIX_VERSION,
  });

  // Single production path: module-owned tool guidance plus the project-owned
  // SupportAgent loop. Rollback at the agent seam is configuration (see
  // SUPPORT_AGENT_ENABLED), never a second policy implementation.
  const structuredSearch = deps.structuredSearch;
  const turnApprovals = createApprovalPolicyForTurn({
    lastUserText,
    userId,
    turnId: turnId ?? 'turn-without-id',
  });
  const catalogTools = buildCatalogToolsForTurn(
        {
          searchChunks: (cfgValue, query, opts) => deps.searchChunks(cfgValue, query, opts),
          agenticSearch: (cfgValue, query, opts) => deps.agenticSearch(cfgValue, query, opts),
          ...(structuredSearch
            ? { structuredSearch: (cfgValue, query, opts) => structuredSearch(cfgValue, query, opts) }
            : {}),
          createTicket: (ticketInput, opts) => deps.createTicket(ticketInput, opts),
          userResolver: async (actorId: string, opts) => {
            if (opts?.signal?.aborted) throw new DOMException('Ticket identity lookup was cancelled.', 'AbortError');
            const profile = await deps.userResolver(request, { signal: opts?.signal });
            if (opts?.signal?.aborted) throw new DOMException('Ticket identity lookup was cancelled.', 'AbortError');
            void actorId;
            return {
              ...(profile.name !== undefined ? { name: profile.name } : {}),
              ...(profile.email !== undefined ? { email: profile.email } : {}),
            };
          },
          rateLimit: deps.rateLimit,
          capabilities: deps.getModelToolCapabilities?.(),
          toolFactory: deps.modelGateway.defineTool,
        },
        {
          cfg,
          effectiveMode,
          userId,
          turnId: turnId ?? 'turn-without-id',
          lastUserText,
          signal: turnSignal,
          groundingEvidence,
          metrics,
          ledger: toolLedger,
          budget: agentBudget,
          approvals: turnApprovals,
          internalToolContext: {
            userId,
            turnId: turnId ?? 'turn-without-id',
          },
          ...(prefetch ? { prefetched: prefetch } : {}),
          ...(prefetch?.usage
            ? {
                initialPlansUsed: prefetch.usage.plansUsed,
                initialPhysicalUsed: prefetch.usage.physicalRetrievalsUsed,
                initialUniqueEvidenceUsed: prefetch.usage.uniqueEvidenceAdded,
                initialTokensUsed: prefetch.usage.evidenceTokensAdded,
              }
            : {}),
        },
      );

  const deriveToolState = () => {
    if (toolLedger.calls.length > 0) return toolLedger.derive();
    {
      return {
        ...prefetchedToolState,
        ticketCreated: false,
        ticketId: null,
      };
    }
  };

  const baseSystemPrompt = buildSystemPrompt(cfg, prefetch?.kind === 'results' ? prefetch.matches : null);
  const systemPrompt = `${baseSystemPrompt}\n\n${catalogTools.guidanceBlock}`;

  // One request/agent deadline seam (F-15): a single immutable run budget
  // carries the turn wall-clock deadline plus an explicit finalization
  // reserve into the agent loop and every tool. The full route/dependency
  // ledger remains WP-8 scope.
  const agentEnabledTools = agentFlag.enabled
    ? new Set([SEARCH_TOOL_NAME, TICKET_TOOL_NAME])
    : new Set<string>();
  // The agent loop drives the compat-wrapped tool envelopes (prefetch
  // reuse, turn ceilings, ledger/metrics recording, ticket safety latches),
  // never the raw catalog instances. Policy lives once in compat; the agent
  // adds loop, budget, and stop policy only.
  const agentCatalog: ToolCatalog = {
    buildForRun: (input) => {
      const tools = new Map<string, BuiltToolInstance>();
      for (const [name, envelope] of Object.entries(catalogTools.executionTools)) {
        if (!input.enabledTools.has(name)) continue;
        tools.set(name, toAgentToolInstance(name, envelope));
      }
      return {
        tools,
        guidanceBlock: catalogTools.guidanceBlock,
        catalogVersion: catalogTools.catalogVersion,
        capabilities: input.capabilities,
      };
    },
  };
  // Model-visible tools are the same compat envelopes the loop executes,
  // built with real schemas and no `execute` (input-only: the SDK returns
  // calls without executing; execution stays in the catalog).
  const modelTools: Record<string, unknown> = {};
  for (const [name, envelope] of Object.entries(catalogTools.executionTools)) {
    modelTools[name] = deps.modelGateway.defineTool({
      description: envelope.description,
      inputSchema: envelope.inputSchema,
      outputSchema: envelope.outputSchema,
      ...(envelope.inputExamples !== undefined ? { inputExamples: envelope.inputExamples } : {}),
      ...(envelope.strict !== undefined ? { strict: envelope.strict } : {}),
    });
  }
  const agentCapabilities = deps.getModelToolCapabilities?.() ?? { ...DEFAULT_TOOL_CAPABILITIES };
  const agentBackend = deps.modelGateway.createModelBackend({
    model: deps.getChatModel(),
    tools: modelTools,
    ...(modelRequestOptions?.providerOptions !== undefined
      ? { providerOptions: modelRequestOptions.providerOptions }
      : {}),
    ...(agentBudget.maxOutputTokens !== undefined ? { maxOutputTokens: agentBudget.maxOutputTokens } : {}),
  });
  const compactedHistory = compactModelHistory(messages);
  const currentMessageIndex = [...compactedHistory]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message.role === 'user')?.index ?? (compactedHistory.length - 1);
  const currentMessage = compactedHistory[currentMessageIndex];
  const agentHistory = compactedHistory
    .filter((_, index) => index !== currentMessageIndex)
    .map(toAgentModelMessage);

  const citationStream = new ReadableStream<ChatChunk>({
    start(controller) {
      (async () => {
        let partialText = '';
        let generationCompletedCleanly = false;
        try {
          const agentRun = await createSupportAgent().run({
            runId: turnId ?? randomUUID(),
            actor: { userId },
            turnId: turnId ?? 'turn-without-id',
            userText: lastUserText,
            history: agentHistory,
            ...(currentMessage !== undefined ? { currentMessage: toAgentModelMessage(currentMessage) } : {}),
            initialSearchUsage: prefetch?.usage,
            systemPrompt,
            signal: turnSignal,
            budget: agentBudget,
            capabilities: agentCapabilities,
            enabledTools: agentEnabledTools,
            catalog: agentCatalog,
            toolContext: {
              actor: { userId },
              turnId: turnId ?? 'turn-without-id',
              evidence: {
                get seenChunkKeys(): ReadonlySet<string> {
                  return groundingEvidence.seenChunkKeys;
                },
                addEvidence: (chunks) => addGroundingEvidence(
                  groundingEvidence,
                  [...chunks] as unknown as Parameters<typeof addGroundingEvidence>[1],
                ),
              },
              trace: catalogTools.trace,
              approvals: turnApprovals,
            },
            backend: agentBackend,
          });
          if (request.signal.aborted) throw new DOMException('Chat turn was cancelled.', 'AbortError');
          generationCompletedCleanly = successfulAgentStop(agentRun.stopReason.kind) && !softDeadlineSignal.aborted;
          const agentDeadlineExceeded = agentRun.stopReason.kind === 'deadline_exceeded';
          const timedOut =
            (softDeadlineFired || agentDeadlineExceeded) &&
            !request.signal.aborted &&
            !generationCompletedCleanly;
          const fallbackReason = timedOut
            ? 'turn_deadline'
            : generationCompletedCleanly
              ? undefined
              : `agent_stop:${agentRun.stopReason.kind}`;
          const finalCandidateText = generationCompletedCleanly
            ? agentRun.text
            : timedOut
              ? ''
              : fallbackTextForAgentStop(agentRun.stopReason.kind);
          // WP-6: the candidate stays server-side until the grounding release
          // decision below. No candidate text, citation, or cache publication
          // may happen before the release policy runs.
          logger.info('chat.turn.agent_run', {
            event: 'chat.turn.agent_run',
            turnId,
            stopReason: agentRun.stopReason.kind,
            totalModelSteps: agentRun.summary.totalModelSteps,
            totalToolCalls: agentRun.summary.totalToolCalls,
            callsByTool: agentRun.summary.callsByTool,
            searchCalls: agentRun.summary.searchCalls,
            searchPlans: agentRun.summary.searchPlans,
            physicalRetrievals: agentRun.summary.physicalRetrievals,
            uniqueEvidenceChunks: agentRun.summary.uniqueEvidenceChunks,
            evidenceTokens: agentRun.summary.evidenceTokens,
            inputTokensUsed: agentRun.summary.inputTokensUsed,
            outputTokensUsed: agentRun.summary.outputTokensUsed,
            supportAgentEnabled: agentFlag.enabled,
          });
          if (timedOut) {
            controller.enqueue({
              type: 'data-guardrail',
              data: { outOfDomain: false, notice: true, isEmpty: false, offerTicket: false, message: TURN_DEADLINE_BANNER_MESSAGE },
            });
            const tid = `deadline-${turnId}`;
            controller.enqueue({ type: 'text-start', id: tid });
            controller.enqueue({
              type: 'text-delta',
              id: tid,
              delta: TURN_DEADLINE_TEXT,
            });
            controller.enqueue({ type: 'text-end', id: tid });
          }
          const answerReadyMs = Math.round(performance.now() - turnStart);
          const derivedToolState = deriveToolState();
          if (derivedToolState.ticketCreated && derivedToolState.ticketId) {
              metrics.ticketCreated = true;
              metrics.ticketId = derivedToolState.ticketId;
          }
          const hasGroundingEvidence = groundingEvidence.documents.length > 0;
          const finalOutOfDomain = !hasGroundingEvidence && derivedToolState.outOfDomain;
          // Documentation grounding is required whenever the turn collected
          // evidence or sought it (genuine no-match wall). Casual no-tool
          // turns release directly, as before.
          const documentationRequired =
            hasGroundingEvidence || derivedToolState.outOfDomain || derivedToolState.isEmpty;
          const ticketEligible = !hasGroundingEvidence && derivedToolState.outOfDomain;
          const releaseEnabled = readGroundedReleaseFlag({ get: (key: string) => process.env[key] }).enabled;

          const releaseBufferedText = (text: string): void => {
            if (text === '') return;
            const textId = `agent-${turnId ?? 'text'}`;
            controller.enqueue({ type: 'text-start', id: textId });
            if (metrics.firstTokenMs === null) {
              metrics.firstTokenMs = Math.round(performance.now() - turnStart);
            }
            controller.enqueue({ type: 'text-delta', id: textId, delta: text });
            partialText = text;
            controller.enqueue({ type: 'text-end', id: textId });
          };

          const verificationStart = performance.now();
          let releasedText = '';
          let releasedCitations = dedupeCitations(capturedCitations);
          // withholdCandidate distinguishes fail-closed outcomes (rejected /
          // unverified-safe) from explicit releases: only casual answers and
          // grader-verified answers release their candidate.
          let withholdCandidate = true;
          let groundingDecision: GroundingDecision | null = null;
          let groundingReason: string | null = null;
          let groundingValidatorOutcome: 'valid' | 'invalid' | 'skipped' = 'skipped';
          let groundingValidatorReason: string | null = null;
          let groundingGraderOutcome: 'supported' | 'unsupported' | 'timeout' | 'unavailable' | 'malformed' | 'skipped' = 'skipped';
          let groundingTimedOut = false;
          let groundingEvidenceChunks = groundingEvidence.structured.length;
          let groundingEvidenceTokens = 0;
          let groundingCitationCount = releasedCitations.length;
          let groundingValidCitations = 0;
          const keepValidCitations = (valid: readonly GroundingCitation[]): void => {
            releasedCitations = releasedCitations.filter((citation) =>
              valid.some((entry) =>
                (entry.chunkUid ?? null) === (citation.chunkUid ?? null) &&
                entry.documentId === citation.documentId &&
                entry.chunkIndex === citation.chunkIndex,
              ),
            );
          };
          if (timedOut || !generationCompletedCleanly) {
            // Deadline and agent-stop fallbacks below; no grounding verification.
          } else if (!documentationRequired) {
            releasedText = finalCandidateText;
            withholdCandidate = false;
            groundingDecision = { kind: 'verified', citations: [] };
          } else {
            const rawCandidateCitations: readonly unknown[] = releasedCitations.map((citation) => ({
              id: citation.id,
              ...(citation.chunkUid !== undefined ? { chunkUid: citation.chunkUid } : {}),
              documentId: citation.documentId,
              chunkIndex: citation.chunkIndex,
              ...(citation.subquestionId !== undefined ? { subquestionId: citation.subquestionId } : {}),
              snippet: citation.snippet,
            }));
            groundingCitationCount = rawCandidateCitations.length;
            const validation = validateCitations({
              citations: rawCandidateCitations,
              evidence: groundingEvidence.structured,
              documentationRequired: true,
            });
            if (validation.kind === 'invalid') {
              groundingValidatorOutcome = 'invalid';
              groundingValidatorReason = validation.reason;
              groundingDecision = { kind: 'rejected', reason: validation.reason };
              groundingReason = validation.reason;
            } else {
              groundingValidatorOutcome = 'valid';
              const groundingInput = assembleGroundingInput({
                evidence: groundingEvidence.structured,
                answeredSubquestionIds: [...new Set(groundingEvidence.structured.flatMap((item) => item.subquestionIds))],
                maxUniqueChunks: agentBudget.maxUniqueEvidenceChunks,
                maxEvidenceTokens: agentBudget.maxEvidenceTokens,
                serializeChunk: (item) => serializeUntrustedChunk({ content: item.content, source: item.source ?? null }),
              });
              groundingEvidenceChunks = groundingInput.totalUniqueChunks;
              groundingEvidenceTokens = groundingInput.totalTokens;
              const validCitations = validation.validCitations;
              groundingValidCitations = validCitations.length;
              {
                if (request.signal.aborted) throw new DOMException('Chat turn was cancelled.', 'AbortError');
                const remainingWorkMs = Math.max(0, workDeadlineAt - Date.now());
                // A disabled hallucination check is passed to the runner as an
                // unavailable grader: deterministic validation still applies,
                // but documentation answers fail closed without verification.
                const checkResult = await runGroundingCheck({
                  candidateText: finalCandidateText,
                  documentationRequired: true,
                  citations: validCitations,
                  evidence: groundingEvidence.structured,
                  documentsText: groundingInput.documentsText,
                  evidenceChunks: groundingInput.totalUniqueChunks,
                  evidenceTokens: groundingInput.totalTokens,
                  validatorOutcome: 'valid',
                  validatorReason: null,
                  validCitations,
                  grader: cfg.hallucinationCheckEnabled ? deps.hallucinationGrader(cfg) : null,
                  releaseEnabled,
                  timeoutMs: remainingWorkMs <= 0 ? 0 : Math.min(GROUNDING_GRADER_TIMEOUT_MS, remainingWorkMs),
                  signal: turnSignal,
                });
                if (checkResult.status === 'cancelled') {
                  // Request cancellation aborts the turn without persisting;
                  // a fired work deadline fails closed as a timeout instead.
                  if (request.signal.aborted) throw new DOMException('Chat turn was cancelled.', 'AbortError');
                  groundingDecision = { kind: 'unverified', reason: 'timeout' };
                  groundingReason = 'timeout';
                  groundingGraderOutcome = 'timeout';
                  groundingTimedOut = true;
                } else {
                  groundingDecision = checkResult.decision;
                  groundingReason = checkResult.decision.kind === 'verified' ? null : checkResult.decision.reason;
                  groundingGraderOutcome = checkResult.telemetry.graderOutcome;
                  groundingTimedOut = checkResult.telemetry.timedOut;
                  if (checkResult.decision.kind === 'verified') {
                    releasedText = finalCandidateText;
                    withholdCandidate = false;
                    keepValidCitations(checkResult.decision.citations);
                  }
                }
              }
            }
          }
          const verificationMs = Math.round(performance.now() - verificationStart);
          metrics.hallucinationMs = verificationMs;
          if (groundingDecision !== null && !withholdCandidate) {
            releaseBufferedText(releasedText);
            for (const src of releasedCitations) {
              controller.enqueue({
                type: 'data-citation',
                data: src,
              });
            }
          } else if (groundingDecision !== null) {
            const safe = safeResponseFor({
              decisionKind: groundingDecision.kind === 'rejected' ? 'rejected' : 'unverified',
              reason: groundingReason ?? groundingDecision.kind,
              ticketEligible,
            });
            releasedText = safe.text;
            releasedCitations = [];
            releaseBufferedText(releasedText);
            controller.enqueue({
              type: 'data-guardrail',
              data: {
                outOfDomain: finalOutOfDomain,
                offerTicket: groundingDecision.kind === 'rejected' ? true : safe.offerTicket,
              },
            });
          }
          const answerReleasedMs = groundingDecision === null ? null : Math.round(performance.now() - turnStart);
          const groundingLogFields = toLogFields({
            answerReadyMs,
            verificationMs,
            answerReleasedMs,
            decisionKind: groundingDecision?.kind ?? 'cancelled',
            decisionReason: groundingReason,
            validatorOutcome: groundingValidatorOutcome,
            validatorReason: groundingValidatorReason,
            graderOutcome: groundingGraderOutcome,
            cancelled: groundingDecision === null,
            timedOut: groundingTimedOut,
            attribution: groundingDecision === null
              ? 'request_cancelled'
              : groundingTimedOut
                ? 'grounding_timeout'
                : groundingGraderOutcome === 'unavailable'
                  ? 'grader_unavailable'
                  : groundingGraderOutcome === 'malformed'
                    ? 'grader_malformed'
                    : 'none',
            evidenceChunks: groundingEvidenceChunks,
            evidenceTokens: groundingEvidenceTokens,
            citationCount: groundingCitationCount,
            validCitationCount: groundingValidCitations,
            traceVersion: GROUNDING_TRACE_VERSION,
          });
          logger.info('chat.turn.grounding', {
            event: 'chat.turn.grounding',
            turnId,
            ...groundingLogFields,
          });
          // Event/telemetry-compatible outcome flags. Rejected replaces the
          // old hallucination-blocked signal; unverified is never presented
          // as grounded and never enters the grounded answer cache.
          const hallucinationBlocked = groundingDecision?.kind === 'rejected';
          const hallucinationTimedOut = groundingTimedOut;
          const isEmpty = !hasGroundingEvidence && (derivedToolState.isEmpty || finalOutOfDomain);
          if (
            cacheKey &&
            cacheLease?.isOwned() === true &&
            !timedOut &&
            generationCompletedCleanly &&
            groundingDecision?.kind === 'verified' &&
            shouldCache({
              citations: releasedCitations,
              blocked: hallucinationBlocked,
              hallucinationTimedOut,
              isEmpty,
              ticketCreated: metrics.ticketCreated,
              cfg,
            })
          ) {
            try {
              const finalAnswer = releasedText;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (deps.traceEnabled) {
                  logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                }
                await cacheLease?.publish(
                  JSON.stringify({
                    v: SEARCH_RESULT_CONTRACT_VERSION,
                    text: finalAnswer,
                    citations: releasedCitations,
                    grounding: { kind: 'verified', traceVersion: GROUNDING_TRACE_VERSION },
                    search: {
                      resultStates: metrics.searchResultStates,
                      scoreMaxima: metrics.maxRetrievalScores,
                    },
                  }),
                  cfg.answerCacheTtlSec,
                );
              }
            } catch (err) {
              logger.warn('Answer cache write skipped', { error: String(err) });
            }
          }
          if (
            turnResultCache &&
            turnResultKey &&
            turnResultCoordinationKey &&
            turnLease?.isOwned() === true &&
            !timedOut &&
            generationCompletedCleanly &&
            groundingDecision?.kind === 'verified'
          ) {
            try {
              const finalAnswer = releasedText;
              if (finalAnswer && finalAnswer.trim() !== '') {
                const guardrail = hallucinationBlocked
                  ? {
                      outOfDomain: finalOutOfDomain,
                      offerTicket: true,
                      isEmpty,
                    }
                  : undefined;
                const groundingMarker = {
                  kind: 'verified' as const,
                  traceVersion: GROUNDING_TRACE_VERSION,
                };
                const versionedPayload = JSON.stringify({
                  v: SEARCH_RESULT_CONTRACT_VERSION,
                  kind: 'turn-result',
                  requestFingerprint: turnRequestHash.current,
                  fingerprintVersion: TURN_FINGERPRINT_VERSION,
                  text: finalAnswer,
                  citations: releasedCitations,
                  grounding: groundingMarker,
                  search: {
                    resultStates: metrics.searchResultStates,
                    scoreMaxima: metrics.maxRetrievalScores,
                  },
                  ...(guardrail ? { guardrail } : {}),
                });
                const compatibilityPayload = JSON.stringify({
                  v: 1,
                  kind: 'turn-result',
                  requestFingerprint: turnRequestHash.preResultContract,
                  fingerprintVersion: TURN_FINGERPRINT_VERSION,
                  text: finalAnswer,
                  citations: [],
                  grounding: groundingMarker,
                  ...(guardrail ? { guardrail } : {}),
                });
                const publishResult = await turnLease.publish(
                  compatibilityPayload,
                  TURN_RESULT_CACHE_TTL_SEC,
                );
                if (publishResult.kind === 'published') {
                  await turnResultCache.set(
                    turnResultKey,
                    versionedPayload,
                    TURN_RESULT_CACHE_TTL_SEC,
                  );
                }
              }
            } catch (err) {
              logger.warn('Turn result cache write skipped', { error: String(err) });
            }
          }
          // Step-level usage is summed from the agent run's per-step
          // telemetry (F-14). A null total means no step reported tokens;
          // it is never presented as a zero-cost cache hit.
          let tokensIn: number | null = null;
          let tokensOut: number | null = null;
          let cacheReadSum: number | null = null;
          let cacheWriteSum: number | null = null;
          let cacheReported = false;
          for (const step of agentRun.stepTelemetry) {
            if (step.inputTokens !== null) tokensIn = (tokensIn ?? 0) + step.inputTokens;
            if (step.outputTokens !== null) tokensOut = (tokensOut ?? 0) + step.outputTokens;
            if (step.cacheReadTokens !== null) cacheReadSum = (cacheReadSum ?? 0) + step.cacheReadTokens;
            if (step.cacheWriteTokens !== null) cacheWriteSum = (cacheWriteSum ?? 0) + step.cacheWriteTokens;
            if (step.cacheStatus === 'reported') cacheReported = true;
          }
          const parsedUsage = { inputTokens: tokensIn, outputTokens: tokensOut };
          let promptCacheUsage: ChatModelUsageTelemetry | null = null;
          if (agentRun.stepTelemetry.length > 0) {
            const status = cacheReported ? 'reported' as const : 'unsupported' as const;
            promptCacheUsage = {
              inputTokens: tokensIn,
              inputTokensStatus: tokensIn !== null ? 'reported' : 'unsupported',
              cachedInputTokens: cacheReadSum,
              cachedInputTokensStatus: status,
              cacheReadTokens: cacheReadSum,
              cacheReadStatus: status,
              cacheWriteTokens: cacheWriteSum,
              cacheWriteStatus: status,
              cacheHitRatio: null,
            };
          }
          const inputTokens = promptCacheUsage?.inputTokens ?? parsedUsage.inputTokens;
          const outputTokens = parsedUsage.outputTokens;
          const totalMs = Math.round(performance.now() - turnStart);
          deps.eventSink.record({
            turnId,
            userId,
            query: queryText,
            mode: persistedMode,
            retrieveMs: metrics.retrieveMs,
            generateMs: Math.max(0, totalMs - metrics.retrieveMs),
            totalMs,
            hitCount: metrics.hitCount,
            maxSimilarity: metrics.maxRetrievalScores.dense ?? null,
            outOfDomain: finalOutOfDomain,
            hallucinationBlocked,
            ticketCreated: metrics.ticketCreated,
            citationCount: releasedCitations.length,
            tokensIn: inputTokens,
            tokensOut: outputTokens,
            meta: buildEventMeta({
              rewritten: metrics.rewritten,
              documentIds: citationDocumentIds(releasedCitations),
              ticketId: metrics.ticketCreated ? metrics.ticketId : null,
              isEmpty,
              resultState: !generationCompletedCleanly ? undefined : derivedToolState.resultState ?? undefined,
              searchResultStates: metrics.searchResultStates,
              retrievalScoreMaxima: metrics.maxRetrievalScores,
              grounding: groundingDecision === null ? undefined : { ...groundingLogFields },
              modelTelemetry: modelRequestOptions?.telemetry,
              promptCache: promptCacheUsage
                ? {
                    inputTokens: promptCacheUsage.inputTokens,
                    inputTokensStatus: promptCacheUsage.inputTokensStatus,
                    cachedInputTokens: promptCacheUsage.cachedInputTokens,
                    cachedInputTokensStatus: promptCacheUsage.cachedInputTokensStatus,
                    cacheReadTokens: promptCacheUsage.cacheReadTokens,
                    cacheReadStatus: promptCacheUsage.cacheReadStatus,
                    cacheWriteTokens: promptCacheUsage.cacheWriteTokens,
                    cacheWriteStatus: promptCacheUsage.cacheWriteStatus,
                    cacheHitRatio: promptCacheUsage.cacheHitRatio,
                  }
                : undefined,
              prefetchStatus: metrics.prefetchStatus,
              prefetchMs: metrics.prefetchMs,
              reformulationCount: metrics.reformulationCount,
              retrievalProvider: deps.getRetrievalProvider?.() ?? 'unknown',
              retrievalMode: persistedMode,
              ...(fallbackReason !== undefined ? { fallbackReason } : {}),
            }),
          });
          logger.info('chat.turn.timings', {
            event: 'chat.turn.timings',
            turnId,
            retrieveMs: metrics.retrieveMs,
            prefetchMs: metrics.prefetchMs,
            prefetchStatus: metrics.prefetchStatus,
            reformulationCount: metrics.reformulationCount,
            retrievalProvider: deps.getRetrievalProvider?.() ?? 'unknown',
            retrievalMode: persistedMode,
            firstTokenMs: metrics.firstTokenMs,
            hallucinationMs: metrics.hallucinationMs,
            generateMs: Math.max(0, totalMs - metrics.retrieveMs),
            totalMs,
          });
          // History persists only the released outcome, never a withheld
          // candidate. Safe fallbacks persist their safe text; cancelled
          // turns never reach this point (the catch path persists nothing
          // except the ticket sentinel).
          const persistedText = releasedText !== '' ? releasedText : partialText;
          const historyPersisted = await persistHistory(deps.historySink, cfg, userId, {
            conversationId: parsed.data.conversationId,
            turnId,
            retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
            title: lastUserText,
            userMessage: lastUserMessage,
            assistantMessage: buildAssistantMessageLike({
              turnId,
              text: persistedText || partialText,
              citations: releasedCitations,
              guardrail: groundingDecision?.kind === 'rejected'
                ? {
                    outOfDomain: finalOutOfDomain,
                    offerTicket: true,
                  }
                : groundingDecision?.kind === 'unverified' && generationCompletedCleanly && !timedOut && releasedText !== finalCandidateText
                  ? {
                      outOfDomain: finalOutOfDomain,
                      offerTicket: ticketEligible,
                    }
                : timedOut
                ? {
                    outOfDomain: derivedToolState.outOfDomain,
                    offerTicket: true,
                  }
                : timedOut
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      notice: true,
                      message: TURN_DEADLINE_BANNER_MESSAGE,
                    }
                  : !generationCompletedCleanly
                    ? {
                        outOfDomain: false,
                        offerTicket: false,
                        notice: true,
                        message: fallbackTextForAgentStop(agentRun.stopReason.kind),
                      }
                    : null,
            }),
          });
          if (historyPersisted && parsed.data.conversationId) {
            controller.enqueue({
              type: 'data-conversation-persisted',
              data: { conversationId: parsed.data.conversationId },
            });
          }
          if (
            turnId &&
            deps.judgeScheduler &&
            deps.qualityJudge &&
            !timedOut &&
            generationCompletedCleanly &&
            groundingDecision?.kind === 'verified' &&
            Math.random() < cfg.judgeSampleRate &&
            releasedCitations.length > 0 &&
            !isEmpty &&
            performance.now() - turnStart <= judgeMaxWallMs &&
            cfg.captureQueryText !== false
          ) {
            const answer = releasedText !== '' ? releasedText : partialText;
            const snippets = releasedCitations.map((c) => c.snippet);
            const qualityJudge = deps.qualityJudge;
            deps.judgeScheduler(() =>
              qualityJudge({
                question: lastUserText,
                snippets,
                documents: snippets.join('\n\n'),
                answer,
                turnId,
              }),
            );
          }
        } catch (err) {
          logger.error('Chat stream error', { error: err });
          try {
            if (metrics.ticketCreated) {
              logger.warn('chat.turn.ticket_created_but_stream_failed', { turnId, ticketId: metrics.ticketId });
              deps.eventSink.record({
                turnId,
                userId,
                query: queryText,
                mode: persistedMode,
                ticketCreated: true,
                hallucinationBlocked: false,
                citationCount: dedupeCitations(capturedCitations).length,
                meta: buildEventMeta({
                  ticketId: metrics.ticketId,
                  resultState: deriveToolState().resultState ?? undefined,
                  isEmpty: deriveToolState().isEmpty || deriveToolState().outOfDomain || undefined,
                }),
              });
              if (cfg.captureQueryText && deps.historySink && parsed.data.conversationId) {
                const orphanTurnId = turnId ?? randomUUID();
                void deps.historySink
                  .appendTurn({
                    userId,
                    conversationId: parsed.data.conversationId,
                    turnId: orphanTurnId,
                    title: lastUserText,
                    userMessage: lastUserMessage ?? { role: 'user', parts: [{ type: 'text', text: lastUserText }] },
                    assistantMessage: buildAssistantMessageLike({
                      turnId: orphanTurnId,
                      text: 'ticket_created_but_stream_failed',
                      citations: dedupeCitations(capturedCitations),
                      guardrail: null,
                    }),
                  })
                  .catch((cause: unknown) =>
                    logger.error('chat.turn.orphan_history_failed', {
                      turnId,
                      error: String(cause),
                    }),
                  );
              }
            }
          } catch {}
          await releaseLeases();
          controller.error(new Error('Chat stream interrupted'));
          return;
        }
        await releaseLeases();
        controller.close();
      })();
    },
  });

  leasesEscaped = true;
  return {
    kind: 'stream',
    stream: citationStream,
    meta: { turnId, mode: persistedMode, cacheHit: false },
  };
  } finally {
    if (!leasesEscaped) await releaseLeases();
  }
}
