import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  chunkBySentences,
  isHeadingLine,
  cleanTextArtifacts,
  estimateTokens,
  tokensPerChar,
  percentile,
  semanticSplitCutoff,
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

  it('hard-splits an unbroken token without exceeding the maximum', () => {
    const s = splitSentences('x'.repeat(25), 10);
    expect(s.map((part) => part.text)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    expect(s.every((part) => Array.from(part.text).length <= 10)).toBe(true);
  });

  it('caps abbreviation-dense accumulation without dropping text', () => {
    const input = 'Dr. '.repeat(15_000).trim();
    const s = splitSentences(input, 100_000);
    expect(s.length).toBeGreaterThan(3);
    expect(s.map((x) => x.text).join(' ')).toBe(input);
    let cursor = 0;
    for (const part of s) {
      expect(part.start).toBeGreaterThanOrEqual(cursor);
      cursor = part.start + part.text.length;
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

  it('applies a small token cap to a single long sentence', () => {
    const chunks = chunkBySentences('x'.repeat(100), 120, 0, 'unknown-model', 10);
    expect(chunks.every((chunk) => estimateTokens(chunk, 'unknown-model') <= 10)).toBe(true);
  });
});

describe('percentile', () => {
  it('returns 0 for an empty sample and clamps the rank', () => {
    expect(percentile([], 90)).toBe(0);
    expect(percentile([1, 2, 3], 101)).toBe(3);
    expect(percentile([1, 2, 3], -5)).toBe(1);
  });

  it('interpolates within a sorted sample without mutating it', () => {
    const values = [3, 1, 2];
    expect(percentile(values, 50)).toBe(2);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(3);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('semanticSplitCutoff', () => {
  it('returns +Infinity when there are no distances', () => {
    expect(semanticSplitCutoff([])).toBe(Number.POSITIVE_INFINITY);
  });

  it('adapts to the sample spread instead of a fixed threshold', () => {
    const tight = semanticSplitCutoff([0.11, 0.12, 0.11, 0.12, 0.5]);
    const wide = semanticSplitCutoff([0.4, 0.45, 0.42, 0.44, 0.9]);
    expect(tight).toBeLessThan(wide);
  });

  it('floors near-uniform documents at the absolute gap', () => {
    expect(semanticSplitCutoff([0.01, 0.02, 0.015], 90, 0.1)).toBe(0.1);
  });
});

describe('isHeadingLine', () => {
  it('treats short body sentences as non-headings', () => {
    expect(isHeadingLine('Yes.')).toBe(false);
    expect(isHeadingLine('See below.')).toBe(false);
    expect(isHeadingLine('42.')).toBe(false);
  });

  it('rejects quantities and footer fragments as numbered headings', () => {
    expect(isHeadingLine('100 MB,')).toBe(false);
    expect(isHeadingLine('2.3.')).toBe(false);
    expect(isHeadingLine('URL.')).toBe(false);
    expect(isHeadingLine('2.1 Web Application Errors')).toBe(true);
    expect(isHeadingLine('4.2.1 Deployment Steps')).toBe(true);
    expect(isHeadingLine('4. Upgrade')).toBe(false);
    expect(isHeadingLine('4. Then')).toBe(false);
    expect(isHeadingLine('4. If the')).toBe(false);
    expect(isHeadingLine('4. Consider purchasing a rate limit boost or')).toBe(false);
    expect(isHeadingLine('4. Click “Test')).toBe(false);
    expect(isHeadingLine('4. Detailed Error Descriptions')).toBe(true);
    expect(isHeadingLine('1. Introduction')).toBe(true);
  });

  it('rejects mid-table ALL-CAPS cells without blank separation', () => {
    expect(isHeadingLine('API', false)).toBe(false);
    expect(isHeadingLine('N/A N/A', false)).toBe(false);
    expect(isHeadingLine('API', true)).toBe(true);
    expect(isHeadingLine('ERR_1602_AUTH_FAILED', false)).toBe(true);
    expect(isHeadingLine('Enterprise:', false)).toBe(false);
    expect(isHeadingLine('Getting Started:')).toBe(true);
    expect(isHeadingLine('A confirmation dialog appears:')).toBe(false);
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
