import { describe, it, expect } from 'vitest';
import { formatDuration } from '../format-duration';

describe('formatDuration', () => {
  it('treats non-positive and non-finite values as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-100)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });

  it('formats seconds without decimals', () => {
    expect(formatDuration(900)).toBe('1s');
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats minutes without decimals', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(90_000)).toBe('2m');
  });

  it('formats hours with one decimal', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(11_520_000)).toBe('3.2h');
  });

  it('formats days with one decimal', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(2_592_000_000)).toBe('30d');
  });
});
