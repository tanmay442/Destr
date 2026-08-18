import { describe, it, expect } from 'vitest';
import { sanitizeText } from './sanitize-text';

describe('sanitizeText', () => {
  it('strips control characters', () => {
    expect(sanitizeText('a\u0000b\u0007c')).toBe('abc');
  });

  it('normalizes CRLF to LF', () => {
    expect(sanitizeText('one\r\ntwo\r\nthree')).toBe('one\ntwo\nthree');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeText('  hello world  ')).toBe('hello world');
  });

  it('keeps normal text unchanged', () => {
    expect(sanitizeText('Plain issue summary.')).toBe('Plain issue summary.');
  });

  it('converts non-breaking and unicode spaces to a regular space', () => {
    expect(sanitizeText('a\u00A0b\u2003c\u3000d')).toBe('a b c d');
  });

  it('strips zero-width and format characters', () => {
    expect(sanitizeText('a\u200Bb')).toBe('ab');
    expect(sanitizeText('a\u200Cb\u200Dc')).toBe('abc');
    expect(sanitizeText('a\uFEFFb')).toBe('ab');
    expect(sanitizeText('a\u00ADb')).toBe('ab');
    expect(sanitizeText('a\u2060b')).toBe('ab');
  });

  it('strips bidi control characters', () => {
    expect(sanitizeText('a\u200Eb\u202Ec')).toBe('abc');
    expect(sanitizeText('a\u202Axxx\u202Cb')).toBe('axxxb');
  });

  it('converts line and paragraph separators to newlines', () => {
    expect(sanitizeText('a\u2028b')).toBe('a\nb');
    expect(sanitizeText('a\u2029b')).toBe('a\nb');
  });

  it('keeps tabs and newlines', () => {
    expect(sanitizeText('a\tb\nc')).toBe('a\tb\nc');
  });
});
