import { randomBytes } from 'node:crypto';
import type { EnvSource } from '@app/domain';

/** Minimum UTF-8 secret size accepted by the signed pagination cursor codec. */
export const MIN_CURSOR_SECRET_BYTES = 32;
export const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
export const MAX_CURSOR_TTL_SECONDS = 24 * 60 * 60;

export interface CursorSigningConfig {
  readonly secret: string;
  readonly previousSecret?: string;
  readonly ttlMs: number;
}

export interface CursorSigningConfigOptions {
  /** Avoid ambient randomness in tests that intentionally exercise fallback configuration. */
  readonly developmentSecret?: string;
}

export const defaultCursorEnv: EnvSource = { get: (key) => process.env[key] };

function hasMinimumSecretBytes(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') >= MIN_CURSOR_SECRET_BYTES;
}

function parseSecret(
  raw: string | undefined,
  label: 'CURSOR_SIGNING_SECRET' | 'CURSOR_SIGNING_PREVIOUS_SECRET',
  required: boolean,
): string | undefined {
  if (raw === undefined || raw.length === 0) {
    if (required) throw new Error(`${label} must be configured in production and contain at least 32 bytes.`);
    return undefined;
  }
  if (!hasMinimumSecretBytes(raw)) {
    throw new Error(`${label} must contain at least 32 bytes.`);
  }
  return raw;
}

function parseTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CURSOR_TTL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_CURSOR_TTL_SECONDS) {
    return DEFAULT_CURSOR_TTL_SECONDS;
  }
  return seconds;
}

/**
 * Parse cursor signing configuration once at the infrastructure boundary.
 * Development/test processes receive an ephemeral local-only secret when no
 * secret is supplied; production must provide an explicit 32-byte secret.
 */
export function parseCursorSigningConfig(
  env: EnvSource = defaultCursorEnv,
  options: CursorSigningConfigOptions = {},
): CursorSigningConfig {
  const production = env.get('NODE_ENV') === 'production';
  const configuredSecret = parseSecret(env.get('CURSOR_SIGNING_SECRET'), 'CURSOR_SIGNING_SECRET', production);
  const secret = configuredSecret ?? options.developmentSecret ?? randomBytes(MIN_CURSOR_SECRET_BYTES).toString('base64url');
  if (!hasMinimumSecretBytes(secret)) {
    throw new Error('The development cursor signing secret must contain at least 32 bytes.');
  }
  const previousSecret = parseSecret(
    env.get('CURSOR_SIGNING_PREVIOUS_SECRET'),
    'CURSOR_SIGNING_PREVIOUS_SECRET',
    false,
  );
  const rawTtl = env.get('CURSOR_TTL_SEC') ?? env.get('CURSOR_TTL_SECONDS');
  return Object.freeze({
    secret,
    ...(previousSecret !== undefined ? { previousSecret } : {}),
    ttlMs: parseTtl(rawTtl) * 1000,
  });
}
