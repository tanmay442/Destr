export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let configuredLevel: LogLevel = 'info';

const MAX_CAUSE_DEPTH = 10;
const SENSITIVE_META_KEY = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|token|private[_-]?key|access[_-]?key)/i;

export function configureLogger(level: LogLevel): void {
  configuredLevel = level;
}

const SECRET_PATTERNS = [
  /postgres:\/\/[^@\s]+@/gi,
  /\bsk_[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9-]+\b/g,
  /\bpk_[A-Za-z0-9_-]+\b/g,
  /\bAuthorization:\s*\S+(?:\s+\S+)?/gi,
];

export function scrubSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function serializeError(value: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: value.name,
    message: value.message,
  };
  const stack = value.stack;
  if (stack) out.stack = stack;
  const code = (value as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  const cause = (value as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.cause = depth >= MAX_CAUSE_DEPTH ? '[cause too deep]' : serializeError(cause, depth + 1);
  }
  else if (cause !== undefined) out.cause = String(cause);
  return out;
}

function serializeMetaValue(
  value: unknown,
  key: string | undefined,
  seen: Set<object>,
): unknown {
  if (key && SENSITIVE_META_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const serializedArray = value.map((entry) => serializeMetaValue(entry, undefined, seen));
    seen.delete(value);
    return serializedArray;
  }
  const serialized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    serialized[childKey] = serializeMetaValue(childValue, childKey, seen);
  }
  seen.delete(value);
  return serialized;
}

function serializeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const seen = new Set<object>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = serializeMetaValue(value, key, seen);
  }
  return out;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[configuredLevel]) return;
  const time = new Date().toISOString();
  let line: string;
  try {
    const entry = {
      level,
      time,
      msg: message,
      ...(meta ? serializeMeta(meta) : {}),
    };
    line = scrubSecrets(JSON.stringify(entry));
  } catch {
    line = scrubSecrets(
      JSON.stringify({ level, time, msg: message, meta: '[unserializable]' }),
    );
  }
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
