import { describe, it, expect } from 'vitest';
import { stripThinkTraces } from './sanitize-think';

describe('stripThinkTraces', () => {
  it('removes a single think block', () => {
    expect(stripThinkTraces('hello <think>secret</think> world')).toBe('hello  world'.trim());
  });

  it('removes multiple think blocks', () => {
    const out = stripThinkTraces('a<think>1</think>b<think>2</think>c');
    expect(out).toBe('abc');
  });

  it('is case-insensitive and handles whitespace', () => {
    expect(stripThinkTraces('<THINK>  x  </THINK>tail')).toBe('tail');
  });

  it('leaves normal text untouched', () => {
    expect(stripThinkTraces('plain content here')).toBe('plain content here');
  });

  it('collapses blank lines and trims', () => {
    expect(stripThinkTraces('\n\n  body  \n\n')).toBe('body');
  });

  it('removes unclosed think tags', () => {
    expect(stripThinkTraces('prefix <think>unclosed thought trace')).toBe('prefix');
  });

  it('removes thinking process text prefixes', () => {
    expect(
      stripThinkTraces(
        'Summary: Here\'s a thinking process: 1. **Analyze User Input:** - Input Document: {"title": "Pricing"}',
      ),
    ).toBe('{"title": "Pricing"}');
  });

});
