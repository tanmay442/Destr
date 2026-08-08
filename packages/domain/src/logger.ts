export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let configuredLevel: LogLevel = 'info';

export function configureLogger(level: LogLevel): void {
  configuredLevel = level;
}

const SECRET_PATTERNS = [
  /postgres:\/\/[^@\s]+@/gi,
  /\bsk_[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9-]+\b/g,
  /\bpk_[A-Za-z0-9_-]+\b/g,
  /\bAuthorization:\s*\S+(?:\s+\S+)?/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function scrubSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function serializeError(value: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: value.name,
    message: value.message,
  };
  const stack = value.stack;
  if (stack) out.stack = stack;
  const code = (value as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  const cause = (value as { cause?: unknown }).cause;
  if (cause instanceof Error) out.cause = serializeError(cause);
  else if (cause !== undefined) out.cause = String(cause);
  return out;
}

function serializeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[configuredLevel]) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(meta ? serializeMeta(meta) : {}),
  };
  const line = scrubSecrets(JSON.stringify(entry));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
};
