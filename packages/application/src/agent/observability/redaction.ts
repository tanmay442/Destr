import type { AgentEvent } from './agent-event';
import { AgentEventSchema } from './agent-event';

export const FORBIDDEN_FIELD_NAMES: readonly string[] = Object.freeze([
  'systemPrompt',
  'systemInstructions',
  'chainOfThought',
  'reasoning',
  'reasoningText',
  'userMessage',
  'userContent',
  'toolArgs',
  'toolArguments',
  'inputArgs',
  'rawArgs',
  'documentText',
  'chunkContent',
  'retrievedContent',
  'retrievedText',
  'content',
  'secret',
  'secrets',
  'apiKey',
  'password',
  'bearer',
  'credential',
  'rawError',
  'rawProviderError',
  'providerError',
  'errorDetail',
  'errorStack',
  'stack',
  'userEmail',
  'email',
  'userName',
  'displayName',
  'ticketContent',
  'ticketBody',
  'ticketQuestion',
  'ticketContext',
  'queryText',
  'rawQuery',
  'promptMessages',
  'messages',
]);

const FORBIDDEN_FIELD_LOOKUP: ReadonlySet<string> = Object.freeze(
  new Set(FORBIDDEN_FIELD_NAMES.map((name) => name.toLowerCase())),
);

export const FORBIDDEN_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-[A-Za-z0-9]{8,}/,
  /bearer\s+[A-Za-z0-9\-._~+/=]{8,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
]);

export const BOUNDED_DIMENSION_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    'environment',
    'region',
    'deployment',
    'agentProfile',
    'agentProfileVersion',
    'agentBudgetVersion',
    'toolCatalogVersion',
    'toolName',
    'toolVersion',
    'provider',
    'modelRole',
    'modelId',
    'status',
    'reasonCode',
    'stopReason',
    'terminalState',
    'decision',
    'modality',
    'retrievalMode',
    'retrievalProfile',
    'cacheLayer',
    'signal',
    'resultKind',
    'coverage',
    'effect',
    'outcome',
  ]),
);

export const MAX_LABEL_VALUE_LENGTH = 128;

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/;

function isForbiddenFieldName(key: string): boolean {
  return FORBIDDEN_FIELD_LOOKUP.has(key.toLowerCase());
}

function matchesForbiddenPattern(value: string): boolean {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

const IDENTIFIER_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|[_-])(turn|trace|user|doc(ument)?|chunk|call|query|ticket|session)[_-]/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\d{5,}$/,
]);

function looksLikeIdentifier(value: string): boolean {
  return IDENTIFIER_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

type AttributeScalar = string | number | boolean | null;

function isSafeLabelValue(value: AttributeScalar): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean' || value === null) return true;
  if (value.length === 0 || value.length > MAX_LABEL_VALUE_LENGTH) return false;
  if (!SAFE_LABEL_PATTERN.test(value)) return false;
  if (matchesForbiddenPattern(value)) return false;
  return !looksLikeIdentifier(value);
}

export interface RedactedAttributes {
  readonly redacted: Readonly<Record<string, AttributeScalar>>;
  readonly removedKeys: readonly string[];
}

export function redactAttributes(
  attrs: Readonly<Record<string, AttributeScalar>>,
): RedactedAttributes {
  const redacted: Record<string, AttributeScalar> = {};
  const removedKeys: string[] = [];
  for (const key of Object.keys(attrs).sort()) {
    const value = attrs[key];
    if (value === undefined || isForbiddenFieldName(key)) {
      removedKeys.push(key);
      continue;
    }
    if (BOUNDED_DIMENSION_KEYS.has(key)) {
      if (!isSafeLabelValue(value)) {
        removedKeys.push(key);
        continue;
      }
      redacted[key] = value;
      continue;
    }
    if (typeof value === 'string' || !isSafeLabelValue(value)) {
      removedKeys.push(key);
      continue;
    }
    redacted[key] = value;
  }
  return {
    redacted: Object.freeze(redacted),
    removedKeys: Object.freeze(removedKeys),
  };
}

export function assertMetricLabelsSafe(labels: Readonly<Record<string, AttributeScalar>>): void {
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value === undefined) throw new Error(`assertMetricLabelsSafe: label ${key} is undefined`);
    if (isForbiddenFieldName(key)) {
      throw new Error(`assertMetricLabelsSafe: forbidden label key ${key}`);
    }
    if (!BOUNDED_DIMENSION_KEYS.has(key) && typeof value === 'string') {
      throw new Error(`assertMetricLabelsSafe: unbounded label key ${key}`);
    }
    if (!isSafeLabelValue(value)) {
      throw new Error(`assertMetricLabelsSafe: unbounded label value for ${key}`);
    }
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return matchesForbiddenPattern(value) ? '[redacted]' : value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenFieldName(key)) continue;
      output[key] = redactValue(entry);
    }
    return output;
  }
  return value;
}

function deepFreezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreezeValue(entry);
    } else {
      for (const entry of Object.values(value)) deepFreezeValue(entry);
    }
    Object.freeze(value);
  }
  return value;
}

export function redactEvent(event: AgentEvent): AgentEvent {
  const { redacted } = redactAttributes(event.attributes);
  const scrubbed = redactValue({ ...event, attributes: { ...redacted } });
  const parsed = AgentEventSchema.parse(scrubbed);
  return deepFreezeValue(parsed);
}
