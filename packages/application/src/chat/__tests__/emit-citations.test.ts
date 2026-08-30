import { describe, it, expect } from 'vitest';
import { emitCitations, citationDocumentIds } from '../emit-citations';
import type { RetrievedChunk } from '@app/application/rag/search';

function chunk(over: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    id: 1,
    documentId: 10,
    fileName: 'doc.pdf',
    page: 2,
    sectionTitle: 'Intro',
    source: 'https://example.com/doc.pdf',
    title: 'Doc',
    content: 'hello world',
    similarity: 0.9,
    ...over,
  };
}

describe('emitCitations', () => {
  it('carries the chunk id and documentId alongside provenance', () => {
    const [c] = emitCitations([chunk({ id: 42, documentId: 7 })]);
    expect(c).toMatchObject({
      id: 42,
      documentId: 7,
      similarity: 0.9,
      fileName: 'doc.pdf',
      page: 2,
      sectionTitle: 'Intro',
      source: 'https://example.com/doc.pdf',
    });
  });

  it('carries stable document and chunk identities', () => {
    const [c] = emitCitations([
      chunk({ documentUid: 'document-uid', chunkUid: 'chunk-uid' }),
    ]);
    expect(c).toMatchObject({ documentUid: 'document-uid', chunkUid: 'chunk-uid' });
  });

  it('truncates the snippet at the snippet max and appends an ellipsis', () => {
    const long = 'x'.repeat(500);
    const [c] = emitCitations([chunk({ content: long })], 100);
    expect(c!.snippet).toHaveLength(101);
    expect(c!.snippet.endsWith('\u2026')).toBe(true);
  });

  it('does not split a surrogate pair when truncating', () => {
    const [c] = emitCitations([chunk({ content: 'a\u{1f600}b' })], 2);
    expect(c!.snippet).toBe('a\u2026');
  });

  it('leaves short snippets intact', () => {
    const [c] = emitCitations([chunk({ content: 'short' })], 100);
    expect(c!.snippet).toBe('short');
  });
});

describe('citationDocumentIds', () => {
  it('returns unique, truthy document ids', () => {
    expect(
      citationDocumentIds([
        { documentId: 3 },
        { documentId: 3 },
        { documentId: 5 },
      ]),
    ).toEqual([3, 5]);
  });

  it('drops missing/zero document ids', () => {
    expect(
      citationDocumentIds([
        { documentId: 0 },
        { documentId: null },
        { documentId: undefined },
        { documentId: 9 },
      ]),
    ).toEqual([9]);
  });
});
