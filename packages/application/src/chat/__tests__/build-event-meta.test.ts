import { describe, it, expect } from 'vitest';
import { buildEventMeta } from '../build-event-meta';

describe('buildEventMeta', () => {
  it('returns an empty object when no signals are present', () => {
    expect(buildEventMeta({})).toEqual({});
  });

  it('includes rewritten only when true', () => {
    expect(buildEventMeta({ rewritten: true })).toEqual({ rewritten: true });
    expect(buildEventMeta({ rewritten: false })).toEqual({});
  });

  it('dedupes and filters document ids', () => {
    expect(buildEventMeta({ documentIds: [3, 3, 0, -1] })).toEqual({ documentIds: [3] });
    expect(buildEventMeta({ documentIds: [] })).toEqual({});
  });

  it('includes the ticket id captured from the createKnowledgeTicket tool result', () => {
    expect(buildEventMeta({ ticketId: 'TKT-abc123' })).toEqual({ ticketId: 'TKT-abc123' });
    expect(buildEventMeta({ ticketId: null })).toEqual({});
    expect(buildEventMeta({ ticketId: undefined })).toEqual({});
  });

  it('merges rewritten, documentIds and ticketId together', () => {
    expect(
      buildEventMeta({ rewritten: true, documentIds: [1, 2], ticketId: 'TKT-zzz' }),
    ).toEqual({ rewritten: true, documentIds: [1, 2], ticketId: 'TKT-zzz' });
  });
});

describe('buildEventMeta quality and agentic metadata', () => {
  it('writes degraded when defined, including false', () => {
    expect(buildEventMeta({ degraded: true })).toEqual({ degraded: true });
    expect(buildEventMeta({ degraded: false })).toEqual({ degraded: false });
    expect(buildEventMeta({ degraded: undefined })).toEqual({});
  });

  it('writes fallbackReason / isEmpty / resultState only when defined', () => {
    expect(
      buildEventMeta({
        fallbackReason: 'grader_unavailable',
        isEmpty: false,
        resultState: 'degraded',
      }),
    ).toEqual({ fallbackReason: 'grader_unavailable', isEmpty: false, resultState: 'degraded' });
    expect(
      buildEventMeta({
        fallbackReason: undefined,
        isEmpty: undefined,
        resultState: undefined,
      }),
    ).toEqual({});
  });

  it('stores judgeScores as a nested object carrying judgedAt', () => {
    const judgedAt = '2026-08-23T00:00:00.000Z';
    expect(
      buildEventMeta({
        judgeScores: { retrievalRelevance: 0.9, faithfulness: 0.8, citationPrecision: 0.75, judgedAt },
      }),
    ).toEqual({
      judgeScores: { retrievalRelevance: 0.9, faithfulness: 0.8, citationPrecision: 0.75, judgedAt },
    });
    expect(buildEventMeta({ judgeScores: undefined })).toEqual({});
  });

  it('merges quality fields alongside the legacy signals', () => {
    expect(
      buildEventMeta({
        rewritten: true,
        documentIds: [1, 2],
        degraded: true,
        fallbackReason: 'all_filtered',
        isEmpty: false,
        resultState: 'degraded',
      }),
    ).toEqual({
      rewritten: true,
      documentIds: [1, 2],
      degraded: true,
      fallbackReason: 'all_filtered',
      isEmpty: false,
      resultState: 'degraded',
    });
  });
});
