import { describe, expect, it } from 'vitest';
import type { EnvSource } from '@app/domain';
import {
  DEFAULT_CURSOR_TTL_SECONDS,
  MAX_CURSOR_TTL_SECONDS,
  MIN_CURSOR_SECRET_BYTES,
  parseCursorSigningConfig,
} from './cursor';

function env(values: Record<string, string | undefined>): EnvSource {
  return { get: (key) => values[key] };
}

describe('parseCursorSigningConfig', () => {
  it('requires a 32-byte current secret in production', () => {
    expect(() => parseCursorSigningConfig(env({ NODE_ENV: 'production' }))).toThrow(/CURSOR_SIGNING_SECRET/);
    expect(() => parseCursorSigningConfig(env({
      NODE_ENV: 'production',
      CURSOR_SIGNING_SECRET: 'too-short',
    }))).toThrow(/32 bytes/);
  });

  it('accepts key rotation and preserves the configured TTL', () => {
    const secret = 'a'.repeat(MIN_CURSOR_SECRET_BYTES);
    const previous = 'b'.repeat(MIN_CURSOR_SECRET_BYTES);
    const config = parseCursorSigningConfig(env({
      NODE_ENV: 'production',
      CURSOR_SIGNING_SECRET: secret,
      CURSOR_SIGNING_PREVIOUS_SECRET: previous,
      CURSOR_TTL_SEC: '600',
    }));
    expect(config.secret).toBe(secret);
    expect(config.previousSecret).toBe(previous);
    expect(config.ttlMs).toBe(600_000);
  });

  it('uses a non-production fallback and bounds malformed TTL values', () => {
    const config = parseCursorSigningConfig(env({ NODE_ENV: 'test', CURSOR_TTL_SEC: 'not-a-number' }));
    expect(Buffer.byteLength(config.secret, 'utf8')).toBeGreaterThanOrEqual(MIN_CURSOR_SECRET_BYTES);
    expect(config.ttlMs).toBe(DEFAULT_CURSOR_TTL_SECONDS * 1000);

    const bounded = parseCursorSigningConfig(env({
      CURSOR_SIGNING_SECRET: 'c'.repeat(MIN_CURSOR_SECRET_BYTES),
      CURSOR_TTL_SECONDS: String(MAX_CURSOR_TTL_SECONDS),
    }));
    expect(bounded.ttlMs).toBe(MAX_CURSOR_TTL_SECONDS * 1000);
  });

  it('rejects a short previous key instead of silently disabling rotation', () => {
    expect(() => parseCursorSigningConfig(env({
      CURSOR_SIGNING_SECRET: 'a'.repeat(MIN_CURSOR_SECRET_BYTES),
      CURSOR_SIGNING_PREVIOUS_SECRET: 'short',
    }))).toThrow(/CURSOR_SIGNING_PREVIOUS_SECRET/);
  });
});
