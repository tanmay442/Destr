import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../../rag/search';
import { addGroundingEvidence, createGroundingEvidence } from '../grounding-evidence';

const CHUNK: RetrievedChunk = {
  id: 1,
  documentId: 10,
  fileName: 'benefits.pdf',
  page: 3,
  sectionTitle: 'Dental',
  source: 'https://example.com/benefits.pdf',
  title: 'Benefits',
  content: 'The dental plan covers two cleanings per year.',
  similarity: 0.91,
};

describe('grounding evidence', () => {
  it('deduplicates chunks while retaining model-visible context beyond citation snippets', () => {
    const evidence = createGroundingEvidence();
    const longChunk = { ...CHUNK, content: `${'x'.repeat(300)} supported detail` };

    const added = addGroundingEvidence(evidence, [longChunk, longChunk]);

    expect(added).toEqual([longChunk]);
    expect(evidence.citations).toHaveLength(1);
    expect(evidence.documents).toHaveLength(1);
    expect(evidence.documents[0]).toContain('supported detail');
    expect(evidence.citations[0]?.snippet).not.toContain('supported detail');
  });

  it('uses stable chunk identities when deduplicating citations', () => {
    const evidence = createGroundingEvidence();
    const first = { ...CHUNK, chunkUid: 'chunk-a' };
    const second = { ...CHUNK, chunkUid: 'chunk-b' };

    expect(addGroundingEvidence(evidence, [first, second, first])).toHaveLength(2);
    expect(evidence.citations.map((citation) => citation.chunkUid)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('bounds the number of unique chunks retained for one turn', () => {
    const evidence = createGroundingEvidence();
    const chunks = Array.from({ length: 35 }, (_, index) => ({ ...CHUNK, id: index + 1 }));

    const added = addGroundingEvidence(evidence, chunks);

    expect(added).toHaveLength(30);
    expect(evidence.citations).toHaveLength(30);
    expect(evidence.documents).toHaveLength(30);
  });
});
