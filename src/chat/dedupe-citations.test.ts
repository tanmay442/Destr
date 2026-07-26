import { describe, it, expect } from 'vitest';
import { dedupeCitations } from './dedupe-citations';

describe('dedupeCitations', () => {
  it('removes citations sharing fileName, page and snippet prefix', () => {
    const citations = [
      { snippet: 'The dental plan covers two cleanings per year.', fileName: 'benefits.pdf', page: 3 },
      { snippet: 'The dental plan covers two cleanings per year.', fileName: 'benefits.pdf', page: 3 },
    ];
    const result = dedupeCitations(citations);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(citations[0]);
  });

  it('keeps the first occurrence and preserves order', () => {
    const citations = [
      { snippet: 'a', fileName: 'a.md', page: null },
      { snippet: 'b', fileName: 'b.md', page: null },
      { snippet: 'a', fileName: 'a.md', page: null },
    ];
    const result = dedupeCitations(citations);
    expect(result.map((c) => c.snippet)).toEqual(['a', 'b']);
  });

  it('treats differing page numbers as distinct', () => {
    const citations = [
      { snippet: 'same text', fileName: 'doc.pdf', page: 1 },
      { snippet: 'same text', fileName: 'doc.pdf', page: 2 },
    ];
    expect(dedupeCitations(citations)).toHaveLength(2);
  });

  it('dedupes on the first 60 characters of the snippet', () => {
    const base = 'x'.repeat(60);
    const citations = [
      { snippet: base + 'AAAA', fileName: null, page: null },
      { snippet: base + 'BBBB', fileName: null, page: null },
    ];
    expect(dedupeCitations(citations)).toHaveLength(1);
  });

  it('handles null and missing identity fields', () => {
    const citations = [
      { snippet: 'text', fileName: null, page: null },
      { snippet: 'text' },
    ];
    expect(dedupeCitations(citations)).toHaveLength(1);
  });
});
