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

  it('removes thought blocks', () => {
    expect(stripThinkTraces('keep <thought>drop me</thought> this')).toBe('keep  this'.trim());
  });

  it('removes antThinking blocks', () => {
    expect(stripThinkTraces('a<antThinking>hidden</antThinking>b')).toBe('ab');
  });

  it('removes reasoning blocks', () => {
    expect(stripThinkTraces('a<reasoning>why</reasoning>b')).toBe('ab');
  });

  it('removes scratchpad blocks', () => {
    expect(stripThinkTraces('a<scratchpad>notes</scratchpad>b')).toBe('ab');
  });

  it('removes bracketed thinking blocks', () => {
    expect(stripThinkTraces('a[thinking]hidden[/thinking]b')).toBe('ab');
  });

  it('is case-insensitive across all patterns', () => {
    expect(stripThinkTraces('a<THOUGHT>x</THOUGHT>b<ANTTHINKING>y</ANTTHINKING>c')).toBe('abc');
    expect(stripThinkTraces('a<Reasoning>x</Reasoning>b[THINKING]y[/THINKING]c')).toBe('abc');
  });

  it('handles whitespace inside tags across patterns', () => {
    expect(stripThinkTraces('a< thought >x</ thought >b')).toBe('ab');
    expect(stripThinkTraces('a<  reasoning  >x</  reasoning  >b')).toBe('ab');
    expect(stripThinkTraces('a[ thinking ]x[ / thinking ]b')).toBe('ab');
  });

  it('removes multiple occurrences of mixed patterns', () => {
    const out = stripThinkTraces(
      'a<think>1</think>b<reasoning>2</reasoning>c[thinking]3[/thinking]d<scratchpad>4</scratchpad>e',
    );
    expect(out).toBe('abcde');
  });

  it('leaves normal text untouched', () => {
    expect(stripThinkTraces('plain content here')).toBe('plain content here');
  });

  it('is idempotent for content without tags', () => {
    const input = 'plain content here';
    expect(stripThinkTraces(stripThinkTraces(input))).toBe(input);
  });

  it('collapses blank lines and trims', () => {
    expect(stripThinkTraces('\n\n  body  \n\n')).toBe('body');
  });
});
