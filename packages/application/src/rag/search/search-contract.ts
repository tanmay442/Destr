import { z } from 'zod';
import { DomainError } from '@app/domain';

const identifierSchema = z.string().trim().min(1).max(100);
const querySchema = z.string().trim().min(1).max(2_000);
const scoreSchema = z.number().finite().nonnegative();

export const retrievalScoresSchema = z.object({
  dense: scoreSchema.optional(),
  lexical: scoreSchema.optional(),
  fusion: scoreSchema.optional(),
  reranker: scoreSchema.optional(),
  finalRank: z.number().int().positive(),
  finalSignal: z.enum(['dense', 'lexical', 'fusion', 'reranker']),
}).superRefine((scores, ctx) => {
  if (scores[scores.finalSignal] === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [scores.finalSignal],
      message: `finalSignal ${scores.finalSignal} requires its corresponding score`,
    });
  }
});

export type RetrievalScores = z.infer<typeof retrievalScoresSchema>;
export type RetrievalSignal = RetrievalScores['finalSignal'];

export const searchDegradationSchema = z.enum([
  'vector_unavailable',
  'lexical_unavailable',
  'reranker_unavailable',
]);

export type SearchDegradation = z.infer<typeof searchDegradationSchema>;

export const searchFailureCodeSchema = z.enum([
  'timeout',
  'cancelled',
  'embedding_unavailable',
  'retrieval_unavailable',
  'reranker_unavailable',
]);

export type SearchFailureCode = z.infer<typeof searchFailureCodeSchema>;

export class SearchFailure extends DomainError {
  readonly name = 'SearchFailure';
  readonly status = 503;

  constructor(
    readonly code: SearchFailureCode,
    readonly retryable: boolean,
    readonly userSafeMessage: string,
    cause?: unknown,
    readonly attemptedQueries?: readonly string[],
  ) {
    super(`Search failed: ${code}`, { cause });
  }
}

export const executedQuerySchema = z.object({
  queryId: identifierSchema,
  query: querySchema,
});

export const searchToolItemSchema = z.object({
  id: z.number().int().positive(),
  chunkUid: z.string().trim().min(1).optional(),
  documentId: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative(),
  subquestionId: identifierSchema,
  executedQueryIds: z.array(identifierSchema).min(1),
  content: z.string(),
  source: z.string().nullable(),
  documentTitle: z.string().optional(),
  section: z.string().optional(),
  scores: retrievalScoresSchema,
});

export const searchSubquestionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('results'),
    subquestionId: identifierSchema,
    requestedQuery: querySchema,
    executedQueries: z.array(executedQuerySchema).min(1),
    results: z.array(searchToolItemSchema).min(1),
    coverage: z.enum(['sufficient', 'partial']),
    hasMore: z.boolean(),
    degradedBy: z.array(searchDegradationSchema),
  }).superRefine((set, ctx) => {
    const queryIds = new Set(set.executedQueries.map((query) => query.queryId));
    if (queryIds.size !== set.executedQueries.length) {
      ctx.addIssue({ code: 'custom', path: ['executedQueries'], message: 'query IDs must be unique within a result set' });
    }
    for (const [index, result] of set.results.entries()) {
      if (result.subquestionId !== set.subquestionId) {
        ctx.addIssue({
          code: 'custom',
          path: ['results', index, 'subquestionId'],
          message: 'result subquestionId must match its containing set',
        });
      }
      for (const queryId of result.executedQueryIds) {
        if (!queryIds.has(queryId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['results', index, 'executedQueryIds'],
            message: 'result query provenance must reference an executed query',
          });
        }
      }
    }
  }),
  z.object({
    kind: z.literal('no_match'),
    subquestionId: identifierSchema,
    requestedQuery: querySchema,
    attemptedQueries: z.array(querySchema).min(1),
    reason: z.enum(['out_of_scope', 'no_relevant_evidence', 'filtered_duplicates']),
    ticketEligible: z.boolean(),
  }).superRefine((set, ctx) => {
    if (set.reason === 'filtered_duplicates' && set.ticketEligible) {
      ctx.addIssue({
        code: 'custom',
        path: ['ticketEligible'],
        message: 'filtered duplicates are existing evidence and cannot be ticket-eligible',
      });
    }
  }),
  z.object({
    kind: z.literal('error'),
    subquestionId: identifierSchema,
    requestedQuery: querySchema,
    attemptedQueries: z.array(querySchema).min(1),
    code: searchFailureCodeSchema,
    retryable: z.boolean(),
    userSafeMessage: z.string().min(1).max(500),
  }),
]);

export type SearchSubquestionResult = z.infer<typeof searchSubquestionResultSchema>;
export type SearchToolItem = z.infer<typeof searchToolItemSchema>;

export const searchToolResultSchema = z.object({
  callId: identifierSchema,
  sets: z.array(searchSubquestionResultSchema).min(1),
  uniqueEvidenceAdded: z.number().int().nonnegative(),
  evidenceTokensAdded: z.number().int().nonnegative(),
  truncatedBy: z.array(z.enum([
    'call_result_limit',
    'subquestion_result_limit',
    'turn_chunk_limit',
    'turn_token_limit',
  ])),
}).superRefine((result, ctx) => {
  const subquestionIds = new Set(result.sets.map((set) => set.subquestionId));
  if (subquestionIds.size !== result.sets.length) {
    ctx.addIssue({ code: 'custom', path: ['sets'], message: 'subquestion IDs must be unique within a tool call' });
  }
});

export type SearchToolResult = z.infer<typeof searchToolResultSchema>;
