import { z } from 'zod';
import {
  logger,
  sanitizeText,
  type AgenticResultState,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk } from '../../rag/search';
import { addGroundingEvidence, formatGroundingReference, type GroundingEvidence } from '../grounding-evidence';
import type { ChatTurnDeps, TurnMetrics } from './turn-types';

function buildChatTools(deps: ChatTurnDeps, opts: {
  cfg: AppConfig;
  effectiveMode: 'agentic' | 'normal';
  userId: string;
  request: Request;
  groundingEvidence: GroundingEvidence;
  outOfDomainRef: { value: boolean };
  isEmptyRef: { value: boolean };
  resultStateRef: { value: AgenticResultState | null };
  metrics: TurnMetrics;
  prefetched?: { query: string; matches: RetrievedChunk[] } | undefined;
}) {
  const {
    cfg,
    effectiveMode,
    userId,
    request,
    groundingEvidence,
    outOfDomainRef,
    isEmptyRef,
    resultStateRef,
    metrics,
    prefetched,
  } = opts;
  let ticketOpenedInTurn = false;
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;
  return {
    searchDocumentation: deps.ai.tool({
      description:
        "Search the org documentation for chunks relevant to the user's question. Returns an array of { content, similarity, documentTitle, section } objects, ordered by similarity (highest first). Call this tool whenever you need to ground an answer in the official docs. You may call it more than once with a reformulated query if the first call returns nothing useful. Each `content` is capped at 800 characters; duplicate chunks are omitted across this turn. Do NOT call this for non-documentation questions (medical, legal, personal).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            'A focused, specific search query. Reformulate vague user wording into a tight phrase (e.g. "school cell phone policy" instead of "phones").',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Maximum number of chunks to return. Defaults to 3. Use a larger value only if the first call returned nothing useful.',
          ),
      }),
      execute: async ({ query, limit }) => {
        let matches: RetrievedChunk[];
        const t0 = performance.now();
        const canReusePrefetch =
          !prefetchedConsumed &&
          prefetched !== undefined &&
          prefetched.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase();
        if (canReusePrefetch) {
          prefetchedConsumed = true;
          metrics.prefetchStatus = 'exact_match_reused';
          matches = prefetched.matches;
          for (const match of matches) {
            if (metrics.maxSimilarity === null || match.similarity > metrics.maxSimilarity) {
              metrics.maxSimilarity = match.similarity;
            }
          }
          metrics.hitCount = (metrics.hitCount ?? 0) + matches.length;
          return matches.map((match) => ({
            content: formatGroundingReference(match),
            similarity: match.similarity,
            documentTitle: match.title ?? undefined,
            section: match.sectionTitle ?? undefined,
          }));
        }
        if (prefetched !== undefined && !prefetchQueryChanged) {
          prefetchQueryChanged = true;
          metrics.prefetchStatus = 'query_changed';
          metrics.reformulationCount += 1;
        }
        if (effectiveMode === 'agentic') {
          const r = await deps.agenticSearch(cfg, query, { signal: request.signal });
          if (!r.ok) {
            logger.error('Agentic retrieval failed', { error: r.error });
            metrics.retrieveMs += Math.round(performance.now() - t0);
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'agentic', query, ms: performance.now() - t0, hits: r.value.chunks.length });
          }
          const hadEvidence = groundingEvidence.documents.length > 0;
          if (r.value.chunks.length > 0 || hadEvidence) {
            outOfDomainRef.value = false;
            isEmptyRef.value = false;
            resultStateRef.value = 'ok';
          } else {
            outOfDomainRef.value = r.value.outOfDomain;
            isEmptyRef.value = r.value.isEmpty;
            resultStateRef.value = r.value.resultState;
          }
          if (r.value.rewrittenQuery && r.value.rewrittenQuery !== query) {
            metrics.rewritten = true;
            metrics.reformulationCount += 1;
          }
          matches = r.value.chunks;
        } else {
          const r = await deps.searchChunks(cfg, query, { limit, signal: request.signal });
          if (!r.ok) {
            logger.error('RAG retrieval failed', { error: r.error });
            metrics.retrieveMs += Math.round(performance.now() - t0);
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'vector', query, ms: performance.now() - t0, hits: r.value.length });
          }
          matches = r.value;
        }
        metrics.retrieveMs += Math.round(performance.now() - t0);
        for (const m of matches) {
          if (metrics.maxSimilarity === null || m.similarity > metrics.maxSimilarity) metrics.maxSimilarity = m.similarity;
        }
        const uniqueMatches = addGroundingEvidence(groundingEvidence, matches);
        metrics.hitCount = (metrics.hitCount ?? 0) + uniqueMatches.length;
        return uniqueMatches.map((m) => ({
          content: formatGroundingReference(m),
          similarity: m.similarity,
          documentTitle: m.title ?? undefined,
          section: m.sectionTitle ?? undefined,
        }));
      },
    }),
    createKnowledgeTicket: deps.ai.tool({
      description:
        'Open a knowledge ticket. Invoke this tool when the user\'s issue cannot be resolved via the available documentation content or the user has explicitly asked to open one, file one, escalate, talk to a human, or submit a complaint. When invoking, provide a structured `issue` summary with appropriate context so the reviewer can understand the full situation without reading the transcript: Product / Question / What was tried / Docs searched / User context.',
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Ignored by the server \u2014 the signed-in user's name is used instead.",
          ),
        email: z
          .string()
          .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)
          .describe(
            "Ignored by the server \u2014 the signed-in user's email is used instead.",
          ),
        issue: z
          .string()
          .max(10_000)
          .describe(
            'Structured ticket summary in the form: Question: ...\nWhat was tried: ...\nDocs searched: ...\nUser context: ...',
          ),
      }),
      execute: async ({ issue }) => {
        if (ticketOpenedInTurn) {
          return {
            ticketId: null,
            status: 'error',
            message: 'A knowledge ticket was already created in this turn.',
          };
        }
        ticketOpenedInTurn = true;
        const ticketLimit = await deps.rateLimit.check(`ticket:${userId}`, { limit: 1, windowMs: 5 * 60_000 });
        if (!ticketLimit.ok) {
          const retryAfterSec = Number.isFinite(ticketLimit.retryAfterMs)
            ? Math.ceil(ticketLimit.retryAfterMs / 1000)
            : undefined;
          return {
            ticketId: null,
            status: 'error',
            message:
              retryAfterSec !== undefined
                ? `Ticket creation is rate limited for this user; retry in about ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`
                : 'Ticket creation is rate limited for this user.',
          };
        }
        const userProfile = await deps.userResolver(request);
        const realName = userProfile.name ?? 'User';
        const realEmail = userProfile.email ?? `${userId}@clerk.user`;
        const result = await deps.createTicket({
          userId,
          name: realName,
          email: realEmail,
          issue: sanitizeText(issue),
        });
        if (!result.ok) {
          logger.error('createKnowledgeTicket: createTicket failed', { error: result.error });
          return { ticketId: null, status: 'error' };
        }
        metrics.ticketCreated = true;
        metrics.ticketId = result.value.ticketId;
        return result.value;
      },
    }),
  };
}

export { buildChatTools };
