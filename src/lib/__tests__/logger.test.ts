import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@/lib/logger';

const loggerFns: Array<{
  fn: (msg: string, meta?: Record<string, unknown>) => void;
  spy: 'error' | 'warn' | 'log';
}> = [
  { fn: logger.error, spy: 'error' },
  { fn: logger.warn, spy: 'warn' },
  { fn: logger.info, spy: 'log' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

function capturedLine(spy: ReturnType<typeof vi.spyOn>): string {
  return String(spy.mock.calls[0]?.[0] ?? '');
}

describe('logger redaction', () => {
  it.each(loggerFns)('$spy redacts a postgres connection string in the message', ({ fn, spy }) => {
    const s = vi.spyOn(console, spy).mockImplementation(() => {});
    fn('connecting to postgres://user:super-secret-password@db.example.com:5432/rag');
    const line = capturedLine(s);
    expect(line).not.toContain('super-secret-password');
    expect(line).toContain('[REDACTED]');
  });

  it.each(loggerFns)('$spy redacts sk_ and pk_ tokens with underscores', ({ fn, spy }) => {
    const s = vi.spyOn(console, spy).mockImplementation(() => {});
    fn('tokens sk_test_abc123def and pk_live_xyz987 leaked');
    const line = capturedLine(s);
    expect(line).not.toContain('sk_test_abc123def');
    expect(line).not.toContain('pk_live_xyz987');
    expect(line).toContain('[REDACTED]');
  });

  it.each(loggerFns)('$spy redacts Authorization header values', ({ fn, spy }) => {
    const s = vi.spyOn(console, spy).mockImplementation(() => {});
    fn('request failed with Authorization: Bearer tok_verysecret123');
    const line = capturedLine(s);
    expect(line).not.toContain('tok_verysecret123');
    expect(line).toContain('[REDACTED]');
  });

  it('redacts a 32+ char token nested in non-Error meta', () => {
    const s = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = '0123456789abcdef0123456789abcdef';
    logger.error('write failed', { body: { auth: { token } } });
    const line = capturedLine(s);
    expect(line).not.toContain(token);
    expect(line).toContain('[REDACTED]');
  });

  it('redacts secrets inside an Error.message and stack', () => {
    const s = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('bad token sk_test_tokengoeshere');
    err.stack = 'Error: bad token sk_test_tokengoeshere\n    at handler (file.ts:1)';
    logger.error('boom', { error: err });
    const line = capturedLine(s);
    expect(line).not.toContain('sk_test_tokengoeshere');
  });

  it('leaves non-secret text untouched', () => {
    const s = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('document ingested', { chunks: 42, documentId: 7 });
    const line = capturedLine(s);
    expect(line).toContain('document ingested');
    expect(line).toContain('"chunks":42');
    expect(line).toContain('"documentId":7');
    expect(line).not.toContain('[REDACTED]');
  });

  it('emits a single JSON line with level, time and msg', () => {
    const s = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('some warning');
    const parsed = JSON.parse(capturedLine(s));
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('some warning');
    expect(typeof parsed.time).toBe('string');
  });

  it('serializes an Error in meta with name, message and code', () => {
    const s = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('nope'), { code: 'external_service' });
    logger.error('failed', { error: err });
    const parsed = JSON.parse(capturedLine(s));
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('nope');
    expect(parsed.error.code).toBe('external_service');
  });
});
