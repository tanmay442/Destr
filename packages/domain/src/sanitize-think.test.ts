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
});
