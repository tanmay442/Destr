import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  chunkBySentences,
  isHeadingLine,
  estimateTokens,
  tokensPerChar,
} from './shared';

describe('splitSentences', () => {
  it('splits on ASCII terminators', () => {
    const s = splitSentences('First sentence. Second one? Third!');
    expect(s.map((x) => x.text)).toEqual(['First sentence.', 'Second one?', 'Third!']);
  });

  it('splits CJK text on 。！？', () => {
    // Regression for M45: ASCII-only splitter left an entire CJK document as
    // one "sentence"; CJK uses 。！？ as terminators, not .!?
    const s = splitSentences('这是第一句。这是第二句！这是第三句？');
    expect(s).toHaveLength(3);
  });

  it('does not split on abbreviation endings like "Dr."', () => {
    const s = splitSentences('Dr. Smith went home. He was tired.');
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain('Dr. Smith');
  });

  it('falls back to max-length splitting for terminator-less text', () => {
    const long = 'word '.repeat(500).trim();
    const s = splitSentences(long, 120);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.text.length <= 130)).toBe(true);
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
});
