
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const configuredLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

const SECRET_PATTERNS = [
  /postgres:\/\/[^@\s]+@/gi,
  /\bsk_[a-zA-Z0-9]+\b/g,
  /\bpk_[a-zA-Z0-9]+\b/g,
  /\bAuthorization:\s*[^\s]+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

function scrubSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// Serialise Error values (JSON.stringify skips non-enumerable props).
function serializeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      const errObj: Record<string, unknown> = {
        message: scrubSecrets(value.message),
        ...(value.stack ? { stack: scrubSecrets(value.stack) } : {}),
      };
      const code = (value as { code?: unknown }).code;
      if (code !== undefined) errObj.code = code;
      const cause = (value as { cause?: unknown }).cause;
      if (cause !== undefined) {
        errObj.cause = cause instanceof Error
          ? { name: cause.name, ...(cause as { code?: unknown }).code !== undefined ? { code: (cause as { code?: unknown }).code } : {} }
          : String(cause);
      }
      out[key] = errObj;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[configuredLevel]) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(meta ? serializeMeta(meta) : {}),
  };
  const line = JSON.stringify(entry);
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
