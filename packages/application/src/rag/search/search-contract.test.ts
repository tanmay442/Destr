import { describe, expect, it } from 'vitest';
import {
  retrievalScoresSchema,
  searchToolResultSchema,
  type SearchToolResult,
} from './search-contract';

function resultSet(): SearchToolResult['sets'][number] {
  return {
    kind: 'results',
    subquestionId: 'account-lockout',
    requestedQuery: 'How do I unlock my account?',
    executedQueries: [{ queryId: 'account-q1', query: 'account unlock' }],
    results: [{
      id: 17,
      chunkUid: 'chunk-account-17',
      documentId: 4,
      chunkIndex: 6,
      subquestionId: 'account-lockout',
      executedQueryIds: ['account-q1'],
      content: 'Use the self-service unlock flow.',
      source: 'Account guide',
      documentTitle: 'Account Guide',
      section: 'Unlocking',
      scores: { dense: 0.88, lexical: 0.4, fusion: 0.03, finalRank: 1, finalSignal: 'fusion' },
    }],
    coverage: 'sufficient',
    hasMore: false,
    degradedBy: [],
  };
}

describe('search result contracts', () => {
  it('validates mixed subquestion states without losing query provenance', () => {
    const parsed = searchToolResultSchema.parse({
      callId: 'call-1',
      sets: [
        resultSet(),
        {
          kind: 'no_match',
          subquestionId: 'refund-window',
          requestedQuery: 'What is the refund window?',
          attemptedQueries: ['refund window', 'refund deadline'],
          reason: 'no_relevant_evidence',
          ticketEligible: true,
        },
        {
          kind: 'error',
          subquestionId: 'shipping-delay',
          requestedQuery: 'Why is shipping delayed?',
          attemptedQueries: ['shipping delay'],
          code: 'retrieval_unavailable',
          retryable: true,
          userSafeMessage: 'The documentation search is temporarily unavailable. Please try again.',
        },
      ],
      uniqueEvidenceAdded: 1,
      evidenceTokensAdded: 9,
      truncatedBy: [],
    });

    expect(parsed.sets.map((set) => set.kind)).toEqual(['results', 'no_match', 'error']);
    const results = parsed.sets[0];
    expect(results?.kind).toBe('results');
    if (results?.kind === 'results') {
      expect(results.results[0]?.executedQueryIds).toEqual(['account-q1']);
      expect(results.results[0]?.subquestionId).toBe('account-lockout');
    }
  });

  it.each([
    { dense: Number.NaN, finalRank: 1, finalSignal: 'dense' },
    { dense: Number.POSITIVE_INFINITY, finalRank: 1, finalSignal: 'dense' },
    { dense: 0.8, finalRank: 0, finalSignal: 'dense' },
    { dense: 0.8, finalRank: -1, finalSignal: 'dense' },
    { dense: 0.8, finalRank: 1, finalSignal: 'reranker' },
  ])('rejects invalid score or rank state %#', (scores) => {
    expect(retrievalScoresSchema.safeParse(scores).success).toBe(false);
  });

  it('rejects item provenance that references another query or subquestion', () => {
    const set = resultSet();
    if (set.kind !== 'results') throw new Error('expected results fixture');
    expect(searchToolResultSchema.safeParse({
      callId: 'call-1',
      sets: [{
        ...set,
        results: [{
          ...set.results[0],
          subquestionId: 'different-question',
          executedQueryIds: ['missing-query'],
        }],
      }],
      uniqueEvidenceAdded: 1,
      evidenceTokensAdded: 1,
      truncatedBy: [],
    }).success).toBe(false);
  });

  it('rejects duplicate subquestion and query IDs', () => {
    const set = resultSet();
    if (set.kind !== 'results') throw new Error('expected results fixture');
    expect(searchToolResultSchema.safeParse({
      callId: 'call-1',
      sets: [
        {
          ...set,
          executedQueries: [set.executedQueries[0], set.executedQueries[0]],
        },
        set,
      ],
      uniqueEvidenceAdded: 1,
      evidenceTokensAdded: 1,
      truncatedBy: [],
    }).success).toBe(false);
  });

  it('rejects ticket eligibility for filtered duplicate evidence', () => {
    expect(searchToolResultSchema.safeParse({
      callId: 'call-duplicates',
      sets: [{
        kind: 'no_match',
        subquestionId: 'account-lockout',
        requestedQuery: 'account unlock',
        attemptedQueries: ['account unlock'],
        reason: 'filtered_duplicates',
        ticketEligible: true,
      }],
      uniqueEvidenceAdded: 0,
      evidenceTokensAdded: 0,
      truncatedBy: [],
    }).success).toBe(false);
  });
});
