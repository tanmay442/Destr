
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
}

export class ValidationError extends DomainError {
  readonly code = 'validation_error';
  readonly status = 400;
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  readonly code = 'unauthorized';
  readonly status = 401;
  constructor(message = 'Unauthorized') {
    super(message);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'forbidden';
  readonly status = 403;
  constructor(message = 'Forbidden') {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found';
  readonly status = 404;
  constructor(message: string = 'The requested resource was not found') {
    super(message);
  }
}

export class ConflictError extends DomainError {
  readonly code = 'conflict';
  readonly status = 409;
  constructor(message: string) {
    super(message);
  }
}

/** 410 Gone: resource soft-deleted or its restore window expired. */
export class GoneError extends DomainError {
  readonly code = 'gone';
  readonly status = 410;
  constructor(message: string) {
    super(message);
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'rate_limited';
  readonly status = 429;
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

export class ExternalServiceError extends DomainError {
  readonly code = 'external_service';
  readonly status = 502;
  constructor(message: string, readonly cause?: unknown) {
    super(message, { cause });
  }
}
