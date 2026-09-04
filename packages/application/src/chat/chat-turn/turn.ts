import type { InferUIMessageChunk } from 'ai';
import { randomUUID } from 'node:crypto';
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
import type { RetrievedChunk } from '../../rag/search';
import { cacheFingerprint } from '../cache-key';
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
import { persistHistory, readBoundedJson } from './turn-io';
import { buildChatTools } from './chat-tools';
import { runHallucinationCheck, DEFAULT_TURN_SOFT_DEADLINE_MS, DEFAULT_JUDGE_MAX_WALL_MS } from './hallucination';
import type { ChatTurnDeps, ChatTurnRequest, ChatTurnResult, ChatModelUsageTelemetry, TurnMetrics } from './turn-types';
import { parseGenerationUsage } from './turn-types';

type UIMessage = ChatUIMessage;

export async function chatTurn(input: ChatTurnRequest, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const turnStart = input.startedAt ?? performance.now();
  const requestStartedAt = Date.now();
  const { request, userId } = input;
  const cfg = await deps.getRuntimeConfig();
  const limit = await deps.rateLimit.check(`chat:${userId}`, CHAT_RATE_LIMIT);
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
    maxSimilarity: null,
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
  const turnResultKey = turnResultCache && turnId
    ? `rag:turn-result:${encodeURIComponent(userId)}:${turnId}`
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
    if (turnResultCache && turnResultKey) {
      let turnResult = await turnResultCache.get(turnResultKey).catch(() => null);
      let turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
      if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
      if (!turnState) {
        const lease = createCacheLease(
          turnResultCache,
          turnResultKey,
          Math.ceil(MAX_DURATION_MS / 1000),
          cacheLeaseOptions,
        );
        const leaseResult = await lease.acquireResult();
        if (leaseResult.kind === 'acquired') {
          turnLease = lease;
          turnResult = await turnResultCache.get(turnResultKey).catch(() => null);
          turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
          if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
        } else if (leaseResult.kind === 'held') {
          const remainingWaitMs = Math.max(
            0,
            MAX_DURATION_MS - (Date.now() - requestStartedAt) - 5_000,
          );
          turnResult = await waitForCachedAnswer(turnResultCache, turnResultKey, {
            timeoutMs: remainingWaitMs,
            signal: request.signal,
          });
          turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
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
            ? {
                citationCount: cachedAnswer.citations.length,
                meta: buildEventMeta({ documentIds: citationDocumentIds(cachedAnswer.citations) }),
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
          deps.ai,
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
    if (deps.traceEnabled) logger.info('rag.cache.get', { query: lastUserText, key: cacheKey });
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
      deps.eventSink.record({
        turnId,
        userId,
        query: queryText,
        mode: persistedMode,
        cacheHit: true,
        totalMs: Math.round(performance.now() - turnStart),
        ...(cachedAnswer.citations.length > 0
          ? {
              citationCount: cachedAnswer.citations.length,
              meta: buildEventMeta({ documentIds: citationDocumentIds(cachedAnswer.citations) }),
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
      const stream = deps.ai.createUIMessageStream<UIMessage>({
        execute: ({ writer }) => {
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

  let prefetch: RetrievedChunk[] | null = null;
  if (cfg.prefetchFirstTurn && isFirstTurn && lastUserText.trim() !== '') {
    const prefetchStartedAt = performance.now();
    const prefetchResult = await deps.searchChunks(cfg, lastUserText, { signal: request.signal });
    metrics.prefetchMs = Math.round(performance.now() - prefetchStartedAt);
    metrics.retrieveMs += metrics.prefetchMs;
    metrics.prefetchStatus = 'performed';
    if (!prefetchResult.ok) {
      logger.error('First-turn pre-fetch failed', { error: prefetchResult.error });
      prefetch = null;
    } else {
      prefetch = addGroundingEvidence(groundingEvidence, prefetchResult.value);
    }
  }

  const modelRequestOptions = deps.getChatModelRequestOptions?.({
    stablePromptPrefix: buildStableSystemPrompt(cfg),
    prefixVersion: SYSTEM_PROMPT_PREFIX_VERSION,
  });

  const outOfDomainRef = { value: false };
  const isEmptyRef = { value: false };
  const resultStateRef = { value: null as AgenticResultState | null };

  const rawSoftDeadlineMs = deps.turnSoftDeadlineMs ?? DEFAULT_TURN_SOFT_DEADLINE_MS;
  const maxSoftDeadlineMs = MAX_DURATION_MS - 5_000;
  let softDeadlineMs = rawSoftDeadlineMs;
  if (softDeadlineMs > maxSoftDeadlineMs) {
    logger.warn('CHAT_SOFT_DEADLINE_MS clamped', { requested: rawSoftDeadlineMs, clamped: maxSoftDeadlineMs });
    softDeadlineMs = maxSoftDeadlineMs;
  }
  const judgeMaxWallMs = deps.judgeMaxWallMs ?? DEFAULT_JUDGE_MAX_WALL_MS;
  const elapsedBeforeStream = Date.now() - requestStartedAt;
  // An already-expired budget must abort immediately; a one-second floor here
  // would let the model run past the application's hard wall-time boundary.
  const softDeadlineMsRemaining = Math.max(0, softDeadlineMs - elapsedBeforeStream);
  const softDeadlineSignal = AbortSignal.timeout(softDeadlineMsRemaining);
  let softDeadlineFired = false;
  softDeadlineSignal.addEventListener('abort', () => {
    softDeadlineFired = true;
  });

  const result = deps.ai.streamText({
    model: deps.getChatModel(),
    system: buildSystemPrompt(cfg, prefetch),
    messages: await deps.ai.convertToModelMessages(compactModelHistory(messages), {
      ignoreIncompleteToolCalls: true,
    }),
    stopWhen: deps.ai.stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: AbortSignal.any([request.signal, softDeadlineSignal]),
    tools: buildChatTools(deps, {
      cfg,
      effectiveMode,
      userId,
      request,
      groundingEvidence,
      outOfDomainRef,
      isEmptyRef,
      resultStateRef,
      metrics,
      ...(prefetch ? { prefetched: { query: lastUserText, matches: prefetch } } : {}),
    }),
    ...(modelRequestOptions?.providerOptions !== undefined
      ? { providerOptions: modelRequestOptions.providerOptions }
      : {}),
  });

  const llmStream = result.toUIMessageStream<UIMessage>({ originalMessages: messages });

  const citationStream = new ReadableStream<InferUIMessageChunk<UIMessage>>({
    start(controller) {
      const reader = llmStream.getReader();
      (async () => {
        let partialText = '';
        let generationCompletedCleanly = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (metrics.firstTokenMs === null && value.type.startsWith('text')) {
              metrics.firstTokenMs = Math.round(performance.now() - turnStart);
            }
            if (value.type === 'text-delta') {
              partialText += value.delta;
            }
            controller.enqueue(value);
          }
          generationCompletedCleanly = !softDeadlineSignal.aborted;
          const timedOut = softDeadlineFired && !request.signal.aborted && !generationCompletedCleanly;
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
          const finalCitations = dedupeCitations(capturedCitations);
          for (const src of finalCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            });
          }
          const hasGroundingEvidence = groundingEvidence.documents.length > 0;
          const finalOutOfDomain = !hasGroundingEvidence && outOfDomainRef.value;
          const hallucinationStart = performance.now();
          const remainingWallMs = MAX_DURATION_MS - (Date.now() - requestStartedAt);
          const hallucinationBudgetMs = Math.min(12_000, Math.max(0, remainingWallMs - 2_000));
          let hallucinationBlocked = false;
          let hallucinationTimedOut = false;
          if (timedOut) {
          } else if (hallucinationBudgetMs <= 0) {
            hallucinationTimedOut = true;
            logger.warn('hallucination check skipped: no wall-time budget', { remainingWallMs });
          } else {
            const hallucinationResult = await runHallucinationCheck({
              controller,
              result,
              groundingDocuments: groundingEvidence.documents,
              hallucinationGrader: deps.hallucinationGrader(cfg),
              enabled: cfg.hallucinationCheckEnabled,
              outOfDomain: finalOutOfDomain,
              timeoutMs: hallucinationBudgetMs,
            });
            hallucinationBlocked = hallucinationResult.blocked;
            hallucinationTimedOut = hallucinationResult.timedOut;
          }
          metrics.hallucinationMs = Math.round(performance.now() - hallucinationStart);
          const isEmpty = !hasGroundingEvidence && (isEmptyRef.value || finalOutOfDomain);
          if (
            cacheKey &&
            cacheLease?.isOwned() === true &&
            !timedOut &&
            shouldCache({
              citations: finalCitations,
              blocked: hallucinationBlocked,
              hallucinationTimedOut,
              isEmpty,
              ticketCreated: metrics.ticketCreated,
              cfg,
            })
          ) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (deps.traceEnabled) {
                  logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                }
                await cacheLease?.publish(
                  JSON.stringify({ v: 1, text: finalAnswer, citations: finalCitations }),
                  cfg.answerCacheTtlSec,
                );
              }
            } catch (err) {
              logger.warn('Answer cache write skipped', { error: String(err) });
            }
          }
          if (turnResultCache && turnResultKey && turnLease?.isOwned() === true && !timedOut) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                const guardrail = hallucinationBlocked
                  ? {
                      outOfDomain: finalOutOfDomain,
                      offerTicket: true,
                      isEmpty,
                    }
                  : undefined;
                await turnLease?.publish(
                  JSON.stringify({
                    v: 1,
                    kind: 'turn-result',
                    requestFingerprint: turnRequestHash.current,
                    fingerprintVersion: TURN_FINGERPRINT_VERSION,
                    text: finalAnswer,
                    citations: finalCitations,
                    ...(guardrail ? { guardrail } : {}),
                  }),
                  TURN_RESULT_CACHE_TTL_SEC,
                );
              }
            } catch (err) {
              logger.warn('Turn result cache write skipped', { error: String(err) });
            }
          }
          const usageCandidate = result.totalUsage !== undefined ? result.totalUsage : result.usage;
          const usageValue = await Promise.resolve(usageCandidate).catch(() => null);
          const parsedUsage = parseGenerationUsage(usageValue);
          let promptCacheUsage: ChatModelUsageTelemetry | null = null;
          if (modelRequestOptions?.parseUsage) {
            try {
              const providerMetadata = result.providerMetadata === undefined
                ? undefined
                : await Promise.resolve(result.providerMetadata).catch(() => undefined);
              promptCacheUsage = modelRequestOptions.parseUsage(usageValue, providerMetadata);
            } catch (cause: unknown) {
              logger.warn('chat.model.prompt_cache_usage_parse_failed', {
                error: String(cause),
              });
            }
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
            maxSimilarity: metrics.maxSimilarity,
            outOfDomain: finalOutOfDomain,
            hallucinationBlocked,
            ticketCreated: metrics.ticketCreated,
            citationCount: finalCitations.length,
            tokensIn: inputTokens,
            tokensOut: outputTokens,
            meta: buildEventMeta({
              rewritten: metrics.rewritten,
              documentIds: citationDocumentIds(finalCitations),
              ticketId: metrics.ticketCreated ? metrics.ticketId : null,
              isEmpty,
              resultState: timedOut ? undefined : resultStateRef.value ?? undefined,
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
              ...(timedOut ? { fallbackReason: 'turn_deadline' as const } : {}),
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
          const persistedText = await Promise.resolve(result.text).catch(() => partialText);
          const historyPersisted = await persistHistory(deps.historySink, cfg, userId, {
            conversationId: parsed.data.conversationId,
            turnId,
            retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
            title: lastUserText,
            userMessage: lastUserMessage,
            assistantMessage: buildAssistantMessageLike({
              turnId,
              text: persistedText || partialText,
              citations: finalCitations,
              guardrail: hallucinationBlocked
                ? {
                    outOfDomain: outOfDomainRef.value,
                    offerTicket: true,
                  }
                : timedOut
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      notice: true,
                      message: TURN_DEADLINE_BANNER_MESSAGE,
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
            Math.random() < cfg.judgeSampleRate &&
            finalCitations.length > 0 &&
            !isEmpty &&
            performance.now() - turnStart <= judgeMaxWallMs &&
            cfg.captureQueryText !== false
          ) {
            const answer = await Promise.resolve(result.text).catch(() => partialText);
            const snippets = finalCitations.map((c) => c.snippet);
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
                  resultState: resultStateRef.value ?? undefined,
                  isEmpty: isEmptyRef.value || outOfDomainRef.value || undefined,
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
