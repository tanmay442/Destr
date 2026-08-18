import { describe, it, expect } from 'vitest';
import { respond, respondResult, toSafeError, isActionError, toActionResult, readBoundedBytes, readBoundedText } from '../http';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  GoneError,
  ConflictError,
  ExternalServiceError,
  RateLimitedError,
  ok,
  err,
  type DomainError,
} from '@app/domain';

describe('respond', () => {
  it('maps ValidationError to 400 with safe message', async () => {
    const res = respond(new ValidationError('Bad input'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid input provided', code: 'validation_error' });
  });

  it('includes ValidationError.details in the response body', async () => {
    const res = respond(
      new ValidationError('invalid_role', { issues: [{ path: ['role'], message: 'invalid' }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation_error');
    expect(body.details).toEqual({ issues: [{ path: ['role'], message: 'invalid' }] });
  });

  it('maps NotFoundError to 404', async () => {
    const res = respond(new NotFoundError('User not found'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'The requested resource was not found', code: 'not_found' });
  });

  it('maps ForbiddenError to 403', async () => {
    const res = respond(new ForbiddenError('Access denied'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'You do not have permission to perform this action', code: 'forbidden' });
  });

  it('maps RateLimitedError to 429 with Retry-After header', async () => {
    const res = respond(new RateLimitedError('Too fast', 5_000));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    const body = await res.json();
    expect(body.code).toBe('rate_limited');
  });

  it('maps generic Error to 500 with safe message', async () => {
    const res = respond(new Error('internal details'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error', code: 'internal_error' });
  });

  it('maps non-Error thrown values (string) to 500, never 200', async () => {
    const res = respond('something went wrong');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('internal_error');
  });

  it('maps non-Error thrown values (null) to 500, never 200', async () => {
    const res = respond(null);
    expect(res.status).toBe(500);
  });

  it('passes through a Response unchanged', () => {
    const original = new Response('ok', { status: 200 });
    const res = respond(original);
    expect(res).toBe(original);
  });
});

describe('respondResult', () => {
  it('returns 200 with the value on ok', async () => {
    const res = respondResult(ok({ data: 'hello' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: 'hello' });
  });

  it('maps an err Result to the correct error status', async () => {
    const res = respondResult(err(new NotFoundError('missing') as DomainError));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('not_found');
  });
});

describe('toSafeError', () => {
  it('returns a safe body for DomainError', () => {
    const body = toSafeError(new ValidationError('x'));
    expect(body.code).toBe('validation_error');
    expect(body.error).toBe('Invalid input provided');
  });

  it('returns internal_error for non-DomainError', () => {
    const body = toSafeError(new Error('boom'));
    expect(body.code).toBe('internal_error');
    expect(body.error).toBe('An unexpected error occurred');
  });

  it('returns internal_error for unknown thrown value (string)', () => {
    const body = toSafeError('something broke');
    expect(body.code).toBe('internal_error');
  });

  it('returns internal_error for null', () => {
    const body = toSafeError(null);
    expect(body.code).toBe('internal_error');
  });
});

describe('respond edge cases', () => {
  it('maps ConflictError to 409', async () => {
    const res = respond(new ConflictError('duplicate'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('conflict');
  });

  it('maps GoneError to 410', async () => {
    const res = respond(new GoneError('expired'));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('gone');
  });

  it('maps ExternalServiceError to 502', async () => {
    const res = respond(new ExternalServiceError('timeout'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('external_service');
  });

  it('maps undefined to 500', async () => {
    const res = respond(undefined);
    expect(res.status).toBe(500);
  });

  it('maps number to 500', async () => {
    const res = respond(42);
    expect(res.status).toBe(500);
  });
});

describe('isActionError', () => {
  it('returns true for a body with a known error code', () => {
    expect(isActionError({ error: 'x', code: 'not_found' })).toBe(true);
    expect(isActionError({ error: 'x', code: 'validation_error' })).toBe(true);
    expect(isActionError({ error: 'x', code: 'internal_error' })).toBe(true);
  });

  it('returns false for a body with an unknown code', () => {
    expect(isActionError({ error: 'x', code: 'y' })).toBe(false);
  });

  it('returns false for a plain value shaped like an error body', () => {
    expect(isActionError({ error: 'some value', code: 'custom' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isActionError(null)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isActionError('error')).toBe(false);
  });

  it('returns false for object missing code', () => {
    expect(isActionError({ error: 'x' })).toBe(false);
  });

  it('returns false for object missing error', () => {
    expect(isActionError({ code: 'not_found' })).toBe(false);
  });
});

describe('toActionResult', () => {
  it('returns value on ok', () => {
    const result = ok({ id: 1 });
    expect(toActionResult(result)).toEqual({ id: 1 });
  });

  it('returns error body on err', () => {
    const result = err(new NotFoundError('missing'));
    const body = toActionResult(result);
    expect(body).toEqual({ error: 'The requested resource was not found', code: 'not_found' });
  });
});

describe('readBoundedBytes', () => {
  it('returns empty bytes for a request with no body', async () => {
    const res = await readBoundedBytes(new Request('http://x'), 1000);
    expect(res).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it('reads a body under the cap byte-for-byte, merging chunks', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hel'));
        controller.enqueue(new TextEncoder().encode('lo '));
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      },
    });
    const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit);
    const res = await readBoundedBytes(req, 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(new TextDecoder().decode(res.bytes)).toBe('hello world');
    expect(res.bytes.byteLength).toBe(11);
  });

  it('is byte-exact for multi-byte UTF-8 content', async () => {
    const text = 'héllo wörld — 中文';
    const req = new Request('http://x', { method: 'POST', body: text });
    const res = await readBoundedBytes(req, 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes.byteLength).toBe(new TextEncoder().encode(text).byteLength);
  });

  it('aborts and reports too-large when a chunk pushes the size past the cap', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'a'.repeat(5001) });
    const res = await readBoundedBytes(req, 5000);
    expect(res).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports too-large across many small streamed chunks', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 100; i += 1) controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit);
    const res = await readBoundedBytes(req, 50);
    expect(res).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports error when the underlying stream errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('network failure'));
      },
    });
    const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit);
    const res = await readBoundedBytes(req, 1000);
    expect(res).toEqual({ ok: false, reason: 'error' });
  });

  it('accepts a body exactly at the cap', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'x'.repeat(5000) });
    const res = await readBoundedBytes(req, 5000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes.byteLength).toBe(5000);
  });
});

describe('readBoundedText', () => {
  it('decodes a small body as UTF-8 text', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    const res = await readBoundedText(req, 1000);
    expect(res).toEqual({ ok: true, text: '{"a":1}' });
  });

  it('reports too-large past the cap', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'y'.repeat(101) });
    const res = await readBoundedText(req, 100);
    expect(res).toEqual({ ok: false, reason: 'too-large' });
  });

  it('returns empty text for a request with no body', async () => {
    const res = await readBoundedText(new Request('http://x'), 1000);
    expect(res).toEqual({ ok: true, text: '' });
  });
});
