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
});