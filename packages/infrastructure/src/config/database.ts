import { logger } from '@app/domain';
import type { EnvSource } from '@app/domain';

/** The maximum pool size accepted from DATABASE_POOL_MAX. */
export const MAX_DATABASE_POOL_SIZE = 20;
/** The default pool size for non-Neon databases and non-production runtimes. */
export const DEFAULT_DATABASE_POOL_SIZE = 20;
/** The conservative production default for Neon serverless deployments. */
export const DEFAULT_NEON_PRODUCTION_POOL_SIZE = 5;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const INSECURE_NEON_SSL_MODES = new Set(['disable', 'allow']);
const NEON_TLS_SSL_MODE = 'verify-full';

export interface DatabaseConfig {
  /** Normalized connection string, or undefined when no database is configured. */
  readonly databaseUrl?: string;
  /** Validated pool maximum selected from DATABASE_POOL_MAX and deployment defaults. */
  readonly poolMax: number;
  readonly isProduction: boolean;
  readonly isNeon: boolean;
  readonly isPooledNeon: boolean;
  /** Hostname used for warning de-duplication; credentials are never included. */
  readonly hostname?: string;
  /** Effective Neon SSL mode. Absent for non-Neon or an unset database URL. */
  readonly sslMode?: string;
}

export interface DatabaseConfigOptions {
  /** Override DATABASE_URL without changing the injected environment source. */
  databaseUrl?: string;
  /** Primarily useful to keep configuration tests independent from process logging. */
  warningLogger?: Pick<typeof logger, 'warn'>;
}

/**
 * The process-backed source is kept in infrastructure. Domain and application
 * code receive an EnvSource instead of reading process.env directly.
 */
export const defaultDatabaseEnv: EnvSource = { get: (key) => process.env[key] };

export interface ParsedDatabaseConnection {
  readonly connectionString: string;
  readonly isNeon: boolean;
  readonly isPooledNeon: boolean;
  readonly hostname: string;
  readonly sslMode?: string;
}

function isNeonHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host.endsWith('.neon.tech') || host.endsWith('.neon.app');
}

function isPooledNeonHostname(hostname: string): boolean {
  const firstLabel = hostname.toLowerCase().replace(/\.$/, '').split('.')[0];
  return firstLabel?.endsWith('-pooler') ?? false;
}

/** Remove a password from a connection string without exposing it in errors/logs. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/:[^@]*@/, ':****@');
  }
}

function invalidDatabaseUrl(url: string, reason: string): Error {
  return new Error(
    `Invalid DATABASE_URL: "${redactDatabaseUrl(url)}". ${reason}`,
  );
}

/**
 * Parse and apply the Neon TLS policy exactly once at the configuration
 * boundary. Neon accepts the historical `require`/`verify-ca` aliases only by
 * upgrading them to certificate-and-hostname verification. An omitted mode is
 * treated the same way because Neon connections are required to verify the
 * server certificate and hostname. Explicit `disable` and `allow` modes are
 * rejected instead of silently weakening transport security.
 */
export function parseDatabaseConnection(rawUrl: string): ParsedDatabaseConnection | undefined {
  if (rawUrl === '') return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw invalidDatabaseUrl(rawUrl, 'Expected a valid postgres connection string.');
  }

  if (!POSTGRES_PROTOCOLS.has(parsed.protocol) || parsed.hostname === '') {
    throw invalidDatabaseUrl(rawUrl, 'Expected a valid postgres:// or postgresql:// connection string.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isNeon = isNeonHostname(hostname);
  const isPooledNeon = isNeon && isPooledNeonHostname(hostname);
  const requestedSslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
  if (isNeon && requestedSslMode && INSECURE_NEON_SSL_MODES.has(requestedSslMode)) {
    throw invalidDatabaseUrl(
      rawUrl,
      `Neon connections cannot use sslmode=${requestedSslMode}; use sslmode=${NEON_TLS_SSL_MODE}.`,
    );
  }

  if (isNeon && requestedSslMode !== NEON_TLS_SSL_MODE) {
    parsed.searchParams.set('sslmode', NEON_TLS_SSL_MODE);
  }

  const connectionString = isNeon ? parsed.toString() : rawUrl;
  const sslMode = isNeon ? (parsed.searchParams.get('sslmode') ?? NEON_TLS_SSL_MODE) : requestedSslMode;
  return {
    connectionString,
    isNeon,
    isPooledNeon,
    hostname,
    ...(sslMode !== null && sslMode !== undefined ? { sslMode } : {}),
  };
}

function resolvePoolMax(
  raw: string | undefined,
  fallback: number,
  warningLogger: Pick<typeof logger, 'warn'>,
): number {
  // An unset or blank value is the documented default, without a noisy warning.
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    warningLogger.warn('[db.config] Invalid DATABASE_POOL_MAX; using the configured default', {
      value: raw,
      fallback,
    });
    return fallback;
  }
  if (parsed > MAX_DATABASE_POOL_SIZE) {
    warningLogger.warn('[db.config] DATABASE_POOL_MAX exceeds the safe maximum; clamping it', {
      value: parsed,
      maximum: MAX_DATABASE_POOL_SIZE,
    });
    return MAX_DATABASE_POOL_SIZE;
  }
  return parsed;
}

const warnedNonPooledNeonHosts = new Set<string>();

function warnIfNonPooledNeon(
  config: DatabaseConfig,
  warningLogger: Pick<typeof logger, 'warn'>,
): void {
  if (!config.isProduction || !config.isNeon || config.isPooledNeon || !config.databaseUrl || !config.hostname) return;
  if (warnedNonPooledNeonHosts.has(config.hostname)) return;
  warnedNonPooledNeonHosts.add(config.hostname);
  warningLogger.warn('[db.config] Production Neon URL is not using a pooled endpoint', {
    host: config.hostname,
    databaseUrl: redactDatabaseUrl(config.databaseUrl),
  });
}

/**
 * Read and validate all database settings from one EnvSource. Callers should
 * retain this result and pass it to the pool/client constructors so neither
 * constructor reparses environment variables or emits duplicate warnings.
 */
export function parseDatabaseConfig(
  env: EnvSource = defaultDatabaseEnv,
  options: DatabaseConfigOptions = {},
): DatabaseConfig {
  const rawUrl = options.databaseUrl !== undefined ? options.databaseUrl : env.get('DATABASE_URL');
  const parsed = parseDatabaseConnection(rawUrl ?? '');
  const isProduction = env.get('NODE_ENV') === 'production';
  const fallback = parsed?.isNeon && isProduction
    ? DEFAULT_NEON_PRODUCTION_POOL_SIZE
    : DEFAULT_DATABASE_POOL_SIZE;
  const poolMax = resolvePoolMax(env.get('DATABASE_POOL_MAX'), fallback, options.warningLogger ?? logger);
  const config: DatabaseConfig = {
    poolMax,
    isProduction,
    isNeon: parsed?.isNeon ?? false,
    isPooledNeon: parsed?.isPooledNeon ?? false,
    ...(parsed?.connectionString !== undefined ? { databaseUrl: parsed.connectionString } : {}),
    ...(parsed?.hostname !== undefined ? { hostname: parsed.hostname } : {}),
    ...(parsed?.sslMode !== undefined ? { sslMode: parsed.sslMode } : {}),
  };
  warnIfNonPooledNeon(config, options.warningLogger ?? logger);
  return Object.freeze(config);
}

/** Reset only the process-local warning de-duplication state (for tests). */
export function resetNonPooledNeonWarnings(): void {
  warnedNonPooledNeonHosts.clear();
}
