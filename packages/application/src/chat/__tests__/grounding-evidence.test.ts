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
  chunkIndex: 0,
  scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' },
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

  it('records every model-visible constituent identity and citation', () => {
    const evidence = createGroundingEvidence();
    const first = { ...CHUNK, id: 11, chunkUid: 'window-a', content: 'A' };
    const second = { ...CHUNK, id: 12, chunkUid: 'window-b', chunkIndex: 1, content: 'B' };
    const resolved = {
      ...first,
      content: 'A\n\nB',
      constituentChunks: [first, second],
    };

    expect(addGroundingEvidence(evidence, [resolved])).toEqual([resolved]);
    expect(evidence.seenChunkKeys).toEqual(new Set(['chunk_uid:window-a', 'chunk_uid:window-b']));
    expect(evidence.citations.map((citation) => citation.chunkUid)).toEqual(['window-a', 'window-b']);
    expect(addGroundingEvidence(evidence, [second])).toEqual([]);
  });

  it('bounds the number of unique chunks retained for one turn', () => {
    const evidence = createGroundingEvidence();
    const chunks = Array.from({ length: 35 }, (_, index) => ({
      ...CHUNK,
      id: index + 1,
      chunkIndex: index,
    }));

    const added = addGroundingEvidence(evidence, chunks);

    expect(added).toHaveLength(30);
    expect(evidence.citations).toHaveLength(30);
    expect(evidence.documents).toHaveLength(30);
  });
});
