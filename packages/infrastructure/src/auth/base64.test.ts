import { describe, it, expect } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64';

describe('base64 helpers', () => {
  it('round-trips unicode strings', () => {
    expect(decodeBase64(encodeBase64('héllo wörld ✓'))).toBe('héllo wörld ✓');
  });

  it('matches the standard base64 alphabet', () => {
    expect(encodeBase64('hello world')).toBe(Buffer.from('hello world', 'utf8').toString('base64'));
  });
});
