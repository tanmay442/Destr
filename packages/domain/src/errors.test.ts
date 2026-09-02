import { describe, expect, it } from 'vitest';
import { RequestCancelledError, isRequestCancellationError } from './errors';

describe('request cancellation errors', () => {
  it('recognizes explicit, platform, and normalized database cancellation', () => {
    expect(isRequestCancellationError(new RequestCancelledError())).toBe(true);
    expect(isRequestCancellationError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isRequestCancellationError({ code: 'ABORT_ERR' })).toBe(true);
    expect(isRequestCancellationError({ code: 'database_query_cancelled' })).toBe(true);
  });

  it('does not relabel an unrelated failure because a signal changed elsewhere', () => {
    expect(isRequestCancellationError(new Error('provider failed'))).toBe(false);
    expect(isRequestCancellationError({ code: '57014', message: 'statement timeout' })).toBe(false);
  });
});
