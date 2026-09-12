import { describe, expect, it } from 'vitest';
import { assembleGroundingInput } from '../grounding-evidence-input';
import type { StructuredEvidenceItem } from '../grounding-decision';

function item(chunkUid: string, content: string, subquestionIds: readonly string[]): StructuredEvidenceItem {
  return {
    chunkUid,
    documentId: 1,
    chunkIndex: 0,
    subquestionIds: [...subquestionIds],
    callIds: ['call-1'],
    queryIds: ['q-1'],
    content,
  };
}

function serialize(item: StructuredEvidenceItem): string {
  return `[${item.chunkUid ?? `${item.documentId}:${item.chunkIndex}`}] ${item.content}`;
}

describe('grounding evidence input assembly (WP-6 coverage-aware packing)', () => {
  it('enforces the unique-chunk cap and reports turn_chunk_limit', () => {
    const evidence = ['k1', 'k2', 'k3', 'k4', 'k5'].map((key) => item(key, `content ${key}`, ['sq-a']));
    const result = assembleGroundingInput({
      evidence,
      answeredSubquestionIds: ['sq-a'],
      maxUniqueChunks: 3,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    expect(result.totalUniqueChunks).toBe(3);
    expect(result.includedKeys).toEqual(['chunk_uid:k1', 'chunk_uid:k2', 'chunk_uid:k3']);
    expect(result.truncatedBy).toEqual(['turn_chunk_limit']);
    expect(result.coversAllAnswered).toBe(true);
  });

  it('enforces the token cap with whole-item granularity', () => {
    const first = item('k1', 'content k1', ['sq-a']);
    const second = item('k2', 'content k2', ['sq-a']);
    const third = item('k3', 'content k3', ['sq-a']);
    const result = assembleGroundingInput({
      evidence: [first, second, third],
      answeredSubquestionIds: ['sq-a'],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 25,
      serializeChunk: serialize,
      estimateTokens: () => 10,
    });
    expect(result.totalUniqueChunks).toBe(2);
    expect(result.totalTokens).toBe(20);
    expect(result.truncatedBy).toEqual(['turn_token_limit']);
    expect(result.documentsText).toBe([serialize(first), serialize(second)].join('\n\n'));
    expect(result.documentsText).not.toContain('content k3');
  });

  it('serializes each shared chunk exactly once across subquestions', () => {
    const evidence = [
      item('shared', 'shared content', ['sq-a', 'sq-b']),
      item('a2', 'alpha content', ['sq-a']),
      item('b2', 'beta content', ['sq-b']),
    ];
    const calls: string[] = [];
    const result = assembleGroundingInput({
      evidence,
      answeredSubquestionIds: ['sq-a', 'sq-b'],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 100000,
      serializeChunk: (entry) => {
        calls.push(entry.chunkUid ?? 'missing');
        return serialize(entry);
      },
    });
    expect([...calls].sort()).toEqual(['a2', 'b2', 'shared']);
    expect(result.totalUniqueChunks).toBe(3);
    const occurrences = result.documentsText.split('[shared] shared content').length - 1;
    expect(occurrences).toBe(1);
  });

  it('keeps a per-subquestion minimum so a dominant topic cannot starve another', () => {
    const dominant = Array.from({ length: 5 }, (_, index) => item(`a${index}`, `alpha ${index}`, ['sq-a']));
    const weak = [item('b0', 'beta content', ['sq-b'])];
    const result = assembleGroundingInput({
      evidence: [...dominant, ...weak],
      answeredSubquestionIds: ['sq-a', 'sq-b'],
      maxUniqueChunks: 2,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    expect(result.omittedSubquestions).toEqual([]);
    expect(result.coversAllAnswered).toBe(true);
    expect(result.includedKeys).toContain('chunk_uid:b0');
    expect(result.totalUniqueChunks).toBe(2);
  });

  it('reports omitted subquestions instead of dropping them silently', () => {
    const result = assembleGroundingInput({
      evidence: [item('a0', 'alpha content', ['sq-a']), item('b0', 'beta content', ['sq-b'])],
      answeredSubquestionIds: ['sq-a', 'sq-b'],
      maxUniqueChunks: 1,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    expect(result.totalUniqueChunks).toBe(1);
    expect(result.omittedSubquestions).toEqual(['sq-b']);
    expect(result.coversAllAnswered).toBe(false);
    expect(result.truncatedBy).toEqual(['turn_chunk_limit']);
  });

  it('marks answered subquestions with no evidence as omitted, never silent', () => {
    const result = assembleGroundingInput({
      evidence: [item('a0', 'alpha content', ['sq-a'])],
      answeredSubquestionIds: ['sq-a', 'sq-missing'],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    expect(result.omittedSubquestions).toEqual(['sq-missing']);
    expect(result.coversAllAnswered).toBe(false);
    expect(result.truncatedBy).toEqual([]);
  });

  it('orders deterministically regardless of input order', () => {
    const forward = [
      item('k1', 'alpha', ['sq-a']),
      item('k2', 'beta', ['sq-b']),
      item('k3', 'gamma', ['sq-a', 'sq-b']),
    ];
    const backward = [...forward].reverse();
    const run = (evidence: readonly StructuredEvidenceItem[]) =>
      assembleGroundingInput({
        evidence,
        answeredSubquestionIds: ['sq-b', 'sq-a'],
        maxUniqueChunks: 2,
        maxEvidenceTokens: 100000,
        serializeChunk: serialize,
      });
    const first = run(forward);
    const second = run(backward);
    expect(second).toEqual(first);
    expect(first.includedKeys).toEqual([...first.includedKeys].sort());
  });

  it('treats empty evidence as vacuously covering when nothing was answered', () => {
    // Vacuous truth: with zero answered subquestions there is no coverage
    // obligation, so an empty pack still reports coversAllAnswered true.
    const result = assembleGroundingInput({
      evidence: [],
      answeredSubquestionIds: [],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    expect(result.documentsText).toBe('');
    expect(result.includedKeys).toEqual([]);
    expect(result.totalUniqueChunks).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.truncatedBy).toEqual([]);
    expect(result.omittedSubquestions).toEqual([]);
    expect(result.coversAllAnswered).toBe(true);
  });

  it('uses the default token estimator when none is injected', () => {
    const only = item('k1', 'abcdefgh', ['sq-a']);
    const result = assembleGroundingInput({
      evidence: [only],
      answeredSubquestionIds: ['sq-a'],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 100000,
      serializeChunk: serialize,
    });
    const serialized = serialize(only);
    expect(result.totalTokens).toBe(Math.max(1, Math.ceil(serialized.length / 4)));
  });
});
