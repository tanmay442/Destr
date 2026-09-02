import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRetryBudget,
  getRetryAfterMs,
  RetryBudgetExceededError,
  retryOnTransient,
} from './retry';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('retry budget', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    expect(getRetryAfterMs({ responseHeaders: { 'Retry-After': '2' } }, now)).toBe(2_000);
    expect(getRetryAfterMs({ responseHeaders: { 'retry-after': 'Sat, 01 Aug 2026 00:00:03 GMT' } }, now)).toBe(3_000);
  });

  it('uses Retry-After for the next attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const budget = createRetryBudget(5_000);
    try {
      const retryable = Object.assign(new Error('rate limited'), {
        statusCode: 429,
        responseHeaders: { 'retry-after': '2' },
      });
      const operation = vi.fn().mockRejectedValueOnce(retryable).mockResolvedValueOnce('ok');
      const pending = retryOnTransient(operation, 'test operation', 2, { budget });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      budget.dispose();
    }
  });

  it('stops during a Retry-After sleep when the shared budget expires', async () => {
    vi.useFakeTimers();
    const budget = createRetryBudget(100);
    try {
      const retryable = Object.assign(new Error('rate limited'), {
        statusCode: 429,
        responseHeaders: { 'retry-after': '10' },
      });
      const operation = vi.fn().mockRejectedValue(retryable);
      const pending = retryOnTransient(operation, 'test operation', 3, { budget });
      const rejection = expect(pending).rejects.toBeInstanceOf(RetryBudgetExceededError);

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
    }
  });
});
