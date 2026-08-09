import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  chunkBySentences,
  isHeadingLine,
  cleanTextArtifacts,
  estimateTokens,
  tokensPerChar,
} from './shared';

describe('splitSentences', () => {
  it('splits on ASCII terminators', () => {
    const s = splitSentences('First sentence. Second one? Third!');
    expect(s.map((x) => x.text)).toEqual(['First sentence.', 'Second one?', 'Third!']);
  });

  it('splits CJK text on 。！？', () => {
    const s = splitSentences('这是第一句。这是第二句！这是第三句？');
    expect(s).toHaveLength(3);
  });

  it('does not split on abbreviation endings like "Dr."', () => {
    const s = splitSentences('Dr. Smith went home. He was tired.');
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain('Dr. Smith');
  });

  it('splits after "no." (not treated as an abbreviation)', () => {
    const s = splitSentences('They said no. He left.');
    expect(s.map((x) => x.text)).toEqual(['They said no.', 'He left.']);
  });

  it('keeps multi-dotted runs like versions intact', () => {
    const s = splitSentences('Version 1.2.3 shipped. Use it today.');
    expect(s.map((x) => x.text)).toEqual(['Version 1.2.3 shipped.', 'Use it today.']);
  });

  it('keeps decimals and file names with dots intact', () => {
    const s = splitSentences('The price is $3.14. See report.pdf for details.');
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain('$3.14');
    expect(s[1]!.text).toContain('report.pdf');
  });

  it('falls back to max-length splitting for terminator-less text', () => {
    const long = 'word '.repeat(500).trim();
    const s = splitSentences(long, 120);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.text.length <= 130)).toBe(true);
  });

  it('tracks hard-split offsets incrementally without re-searching', () => {
    const s = splitSentences('word word word '.repeat(60).trim(), 100);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.start >= 0)).toBe(true);
    expect(s[0]!.start).toBe(0);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.start).toBeGreaterThan(s[i - 1]!.start);
    }
  });
});

describe('cleanTextArtifacts', () => {
  it('keeps whitespace-column numeric tables', () => {
    const cleaned = cleanTextArtifacts('Plan   Cost\n19.99  29.99\n42  17  3.1');
    expect(cleaned).toContain('19.99  29.99');
    expect(cleaned).toContain('42  17  3.1');
  });

  it('drops orphaned list artifacts and lone numbers', () => {
    const cleaned = cleanTextArtifacts('•\n-\n1.\n42\nword');
    expect(cleaned).toBe('word');
  });

  it('keeps lines with letters', () => {
    const cleaned = cleanTextArtifacts('A real sentence\n•\nmore text');
    expect(cleaned).toBe('A real sentence\nmore text');
  });
});

describe('chunkBySentences', () => {
  it('does not emit a leading space when overlap is zero', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} here.`).join(' ');
    const chunks = chunkBySentences(text, 80, 0);
    expect(chunks.every((c) => !c.startsWith(' '))).toBe(true);
  });

  it('caps carried overlap suffix so chunks do not grow unbounded', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const chunks = chunkBySentences(text, 120, 1000);
    expect(chunks.every((c) => c.length <= 120 + 1000)).toBe(true);
  });

  it('enforces both the char maxSize and the token cap (H26)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} here now.`).join(' ');
    const chunks = chunkBySentences(text, 120, 0, 'text-embedding-3-small', 400);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.every((c) => estimateTokens(c, 'text-embedding-3-small') <= 400)).toBe(true);
  });
});

describe('isHeadingLine', () => {
  it('treats short body sentences as non-headings', () => {
    expect(isHeadingLine('Yes.')).toBe(false);
    expect(isHeadingLine('See below.')).toBe(false);
    expect(isHeadingLine('42.')).toBe(false);
  });

  it('treats markdown and all-caps lines as headings', () => {
    expect(isHeadingLine('# Introduction')).toBe(true);
    expect(isHeadingLine('OVERVIEW')).toBe(true);
    expect(isHeadingLine('Getting Started:')).toBe(true);
  });
});

describe('token estimation', () => {
  it('uses 1 token/char default and lower rate for known English models', () => {
    expect(tokensPerChar('unknown-model')).toBe(1);
    expect(tokensPerChar('text-embedding-3-small')).toBe(0.25);
    expect(estimateTokens('a'.repeat(400), 'unknown-model')).toBe(400);
    expect(estimateTokens('a'.repeat(400), 'text-embedding-3-small')).toBe(100);
  });

  it('knows google and ollama embedding models (H26)', () => {
    expect(tokensPerChar('gemini-embedding-001')).toBe(0.25);
    expect(tokensPerChar('gemini-embedding-002')).toBe(0.25);
    expect(tokensPerChar('embeddinggemma:latest')).toBe(0.25);
  });
});
