import { describe, expect, it } from 'vitest';
import { validateCitations } from '../citation-validator';
import type { GroundingCitation, StructuredEvidenceItem } from '../grounding-decision';

const REFUND_CONTENT = 'The refund deadline is 30 days after purchase. Contact support for exceptions.';
const SHIPPING_CONTENT = 'Standard shipping takes five business days. Express options are available.';

function evidence(
  documentId: number,
  chunkIndex: number,
  content: string,
  subquestionIds: readonly string[] = ['sq-a'],
): StructuredEvidenceItem {
  return {
    documentId,
    chunkIndex,
    subquestionIds: [...subquestionIds],
    callIds: ['call-1'],
    queryIds: ['q-1'],
    content,
  };
}

function citation(
  id: number,
  documentId: number,
  chunkIndex: number,
  snippet: string,
  subquestionId = 'sq-a',
): GroundingCitation {
  return { id, documentId, chunkIndex, subquestionId, snippet };
}

describe('citation validator (WP-6 deterministic pre-grader checks)', () => {
  it('accepts citations whose snippets are supported by turn evidence', () => {
    const outcome = validateCitations({
      citations: [
        citation(1, 1, 0, 'refund deadline is 30 days', 'sq-a'),
        citation(2, 2, 0, 'Standard shipping takes five business days', 'sq-b'),
      ],
      evidence: [evidence(1, 0, REFUND_CONTENT, ['sq-a']), evidence(2, 0, SHIPPING_CONTENT, ['sq-b'])],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('valid');
    if (outcome.kind !== 'valid') return;
    expect(outcome.validCitations).toHaveLength(2);
    expect(outcome.validCitations.map((item) => item.subquestionId)).toEqual(['sq-a', 'sq-b']);
    expect(outcome.validCitations.map((item) => item.id)).toEqual([1, 2]);
  });

  it('rejects citations that point at evidence never collected in the turn', () => {
    const outcome = validateCitations({
      citations: [citation(3, 99, 0, 'refund deadline is 30 days')],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome).toEqual({
      kind: 'invalid',
      reason: 'missing_citation',
      invalidIds: [3],
      detail: 'unknown_citation:3',
    });
    if (outcome.kind !== 'invalid') return;
    expect(outcome.detail).not.toContain('refund');
  });

  it('rejects out-of-turn chunk indexes from an otherwise known document', () => {
    const outcome = validateCitations({
      citations: [citation(4, 1, 7, 'refund deadline is 30 days')],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('missing_citation');
    expect(outcome.invalidIds).toEqual([4]);
  });

  it('rejects duplicate stable keys because duplicates cannot verify', () => {
    const outcome = validateCitations({
      citations: [
        citation(1, 1, 0, 'refund deadline is 30 days'),
        citation(2, 1, 0, 'Contact support for exceptions'),
      ],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome).toEqual({
      kind: 'invalid',
      reason: 'missing_citation',
      invalidIds: [1, 2],
      detail: 'duplicate_citation:1,2',
    });
  });

  it('rejects malformed citations without leaking content', () => {
    const malformed = { id: -1, documentId: 1, chunkIndex: 0, snippet: 'x' } as unknown as GroundingCitation;
    const outcome = validateCitations({
      citations: [malformed],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('missing_citation');
    expect(outcome.detail.startsWith('malformed_citation:')).toBe(true);
    expect(outcome.detail).not.toContain('refund');
  });

  it('requires at least one citation when documentation is required', () => {
    const outcome = validateCitations({
      citations: [],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome).toEqual({
      kind: 'invalid',
      reason: 'missing_citation',
      invalidIds: [],
      detail: 'missing_citation:required',
    });
  });

  it('rejects unsupported snippets without echoing candidate text', () => {
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, 'the moon is made of cheese')],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('unsupported_claim');
    expect(outcome.invalidIds).toEqual([1]);
    expect(outcome.detail.startsWith('unsupported_snippet:')).toBe(true);
    expect(outcome.detail).not.toContain('cheese');
    expect(outcome.detail).not.toContain('refund');
  });

  it('matches snippets across whitespace differences after normalization', () => {
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, 'refund\ndeadline\tis   30 days')],
      evidence: [evidence(1, 0, 'The  refund\ndeadline\tis 30 days after purchase.')],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('valid');
  });

  it('accepts a snippet with one stripped trailing ellipsis', () => {
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, 'The refund deadline is 30 days…')],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('valid');
  });

  it('rejects snippets that normalize to empty', () => {
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, '   ')],
      evidence: [evidence(1, 0, REFUND_CONTENT)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('unsupported_claim');
    expect(outcome.detail.startsWith('empty_snippet:')).toBe(true);
  });

  it('rejects overlong snippets even when their text is supported', () => {
    const content = 'b'.repeat(2500);
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, 'b'.repeat(2001))],
      evidence: [evidence(1, 0, content)],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('unsupported_claim');
    expect(outcome.invalidIds).toEqual([1]);
    expect(outcome.detail.startsWith('snippet_too_long:')).toBe(true);
  });

  it('accepts a snippet exactly at the length bound when supported', () => {
    const outcome = validateCitations({
      citations: [citation(1, 1, 0, 'b'.repeat(2000))],
      evidence: [evidence(1, 0, 'b'.repeat(2500))],
      documentationRequired: true,
    });
    expect(outcome.kind).toBe('valid');
  });

  it('allows the casual path with zero citations and no evidence', () => {
    const outcome = validateCitations({
      citations: [],
      evidence: [],
      documentationRequired: false,
    });
    expect(outcome).toEqual({ kind: 'valid', validCitations: [] });
  });
});
