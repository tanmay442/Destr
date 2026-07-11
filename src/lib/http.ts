import {
  DomainError,
  ValidationError,
  RateLimitedError,
  type Result,
} from '@app/domain';

const SAFE_MESSAGES: Record<string, string> = {
  validation_error: 'Invalid input provided',
  not_found: 'The requested resource was not found',
  forbidden: 'You do not have permission to perform this action',
  unauthorized: 'Please sign in to continue',
  conflict: 'A conflict occurred',
  gone: 'This resource is no longer available',
  rate_limited: 'Too many requests. Please try again later.',
  external_service: 'An external service is temporarily unavailable',
};

export type SafeErrorBody = {
  error: string;
  code: string;
  details?: Record<string, unknown>;
};

// Safe error body; never leaks internals.
function toErrorBody(err: DomainError): SafeErrorBody {
  const body: SafeErrorBody = {
    error: SAFE_MESSAGES[err.code] ?? 'An error occurred',
    code: err.code,
  };
  if (err instanceof ValidationError && err.details) {
    body.details = err.details;
  }
  return body;
}

export function toSafeError(err: unknown): SafeErrorBody {
  if (err instanceof DomainError) return toErrorBody(err);
  return { error: 'An unexpected error occurred', code: 'internal_error' };
}

export function toActionResult<T>(result: Result<T>): T | SafeErrorBody {
  if (result.ok) return result.value;
  return toErrorBody(result.error);
}

export function isActionError<T>(
  result: T | SafeErrorBody,
): result is SafeErrorBody {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    'code' in result &&
    typeof (result as SafeErrorBody).error === 'string' &&
    typeof (result as SafeErrorBody).code === 'string'
  );
}

// DomainError → status + safe body; generic/unknown → 500. Never 200.
export function respond(err: Error | DomainError | Response | unknown): Response {
  if (err instanceof DomainError) {
    const headers: Record<string, string> = {};
    if (err instanceof RateLimitedError && Number.isFinite(err.retryAfterMs)) {
      headers['Retry-After'] = String(Math.ceil(err.retryAfterMs / 1000));
    }
    return Response.json(toErrorBody(err), { status: err.status, headers });
  }
  if (err instanceof Response) return err;
  return Response.json(
    { error: 'Internal server error', code: 'internal_error' },
    { status: 500 },
  );
}

export function respondResult<T>(result: Result<T>): Response {
  if (result.ok) return Response.json(result.value);
  return respond(result.error);
}
