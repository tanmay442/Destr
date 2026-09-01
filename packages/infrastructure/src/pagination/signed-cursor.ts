import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_CURSOR_TTL_MS,
  MAX_CURSOR_LENGTH,
  isListCursorKind,
  parseListCursorPayload,
  type CursorContext,
  type CursorDecodeResult,
  type ListCursorCodec,
  type ListCursorPayload,
} from '@app/domain';
import {
  parseCursorSigningConfig,
  type CursorSigningConfig,
  type CursorSigningConfigOptions,
} from '../config/cursor';
import type { EnvSource } from '@app/domain';

const SIGNATURE_BYTES = 32;
const MAX_CONTEXT_BINDING_LENGTH = 4096;

interface WireRecord {
  readonly v: 2;
  readonly k: unknown;
  readonly t: unknown;
  readonly i: unknown;
  readonly n: unknown;
  readonly f: unknown;
  readonly s: unknown;
  readonly a: unknown;
  readonly e: unknown;
  readonly sig: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64');
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function digestFilterBinding(binding: string): string {
  return createHash('sha256').update(binding, 'utf8').digest('hex');
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function encodeDate(value: Date, label: string): string {
  if (!validDate(value)) throw new TypeError(`Cannot encode a cursor with an invalid ${label}`);
  return value.toISOString();
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const parsed = new Date(value);
  return validDate(parsed) ? parsed : null;
}

function isValidSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
}

interface UnsignedWire {
  readonly v: unknown;
  readonly k: unknown;
  readonly t: unknown;
  readonly i: unknown;
  readonly n: unknown;
  readonly f: unknown;
  readonly s: unknown;
  readonly a: unknown;
  readonly e: unknown;
}

function canonicalUnsignedWire(value: UnsignedWire): string {
  return JSON.stringify({
    v: value.v,
    k: value.k,
    t: value.t,
    i: value.i,
    n: value.n,
    f: value.f,
    s: value.s,
    a: value.a,
    e: value.e,
  });
}

function equalDigest(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function verifySignature(unsigned: string, signature: string, keys: readonly string[]): boolean {
  const actual = decodeBase64Url(signature);
  if (actual === null || actual.length !== SIGNATURE_BYTES) return false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(unsigned, 'utf8').digest();
    if (equalDigest(expected, actual)) return true;
  }
  return false;
}

function wireRecord(value: unknown): WireRecord | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(['v', 'k', 't', 'i', 'n', 'f', 's', 'a', 'e', 'sig']);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) return null;
  if (
    value.v !== 2 ||
    !('k' in value) ||
    !('t' in value) ||
    !('i' in value) ||
    !('n' in value) ||
    !('f' in value) ||
    !('s' in value) ||
    !('a' in value) ||
    !('e' in value) ||
    !('sig' in value)
  ) return null;
  return {
    v: 2,
    k: value.k,
    t: value.t,
    i: value.i,
    n: value.n,
    f: value.f,
    s: value.s,
    a: value.a,
    e: value.e,
    sig: value.sig,
  };
}

function invalid(reason: Extract<CursorDecodeResult, { kind: 'invalid' }>['reason']): CursorDecodeResult {
  return { kind: 'invalid', reason };
}

function candidatePayload(wire: WireRecord, context: CursorContext): ListCursorPayload | null {
  const sortAt = parseDate(wire.t);
  const issuedAt = parseDate(wire.a);
  const expiresAt = parseDate(wire.e);
  if (sortAt === null || issuedAt === null || expiresAt === null) return null;
  if (typeof wire.s !== 'string' || wire.s.length === 0 || wire.s.length > 128) return null;
  if (!isListCursorKind(wire.k)) return null;
  const candidate: unknown = wire.k === 'users'
    ? {
        kind: 'users',
        sortAt,
        clerkUserId: wire.i,
        total: wire.n,
        filterFingerprint: context.filterFingerprint,
        sort: wire.s,
        issuedAt,
        expiresAt,
      }
    : {
        kind: wire.k,
        sortAt,
        id: wire.i,
        total: wire.n,
        filterFingerprint: context.filterFingerprint,
        sort: wire.s,
        issuedAt,
        expiresAt,
      };
  return parseListCursorPayload(candidate);
}

/** Create the production HMAC-SHA-256 implementation of the domain cursor port. */
export function createSignedListCursorCodec(
  config: CursorSigningConfig = parseCursorSigningConfig(),
): ListCursorCodec {
  if (Buffer.byteLength(config.secret, 'utf8') < 32) {
    throw new Error('Cursor signing secret must contain at least 32 bytes.');
  }
  if (config.previousSecret !== undefined && Buffer.byteLength(config.previousSecret, 'utf8') < 32) {
    throw new Error('Previous cursor signing secret must contain at least 32 bytes.');
  }
  const keys = config.previousSecret === undefined
    ? [config.secret]
    : [config.secret, config.previousSecret];
  const ttlMs = Number.isSafeInteger(config.ttlMs) && config.ttlMs > 0
    ? config.ttlMs
    : DEFAULT_CURSOR_TTL_MS;

  return {
    encode(payload: ListCursorPayload): string {
      const parsed = parseListCursorPayload(payload);
      if (parsed === null) throw new TypeError('Cannot encode an invalid list cursor payload');
      if (parsed.filterFingerprint.length > MAX_CONTEXT_BINDING_LENGTH) {
        throw new TypeError('Cursor filter binding is too long');
      }
      const issuedAt = parsed.issuedAt ?? new Date();
      const expiresAt = parsed.expiresAt ?? new Date(issuedAt.getTime() + ttlMs);
      if (!validDate(issuedAt) || !validDate(expiresAt) || expiresAt.getTime() <= issuedAt.getTime()) {
        throw new TypeError('Cannot encode a cursor with an invalid expiry window');
      }
      const unsigned: UnsignedWire = {
        v: 2,
        k: parsed.kind,
        t: encodeDate(parsed.sortAt, 'sort date'),
        i: parsed.kind === 'users' ? parsed.clerkUserId : parsed.id,
        n: parsed.total,
        f: digestFilterBinding(parsed.filterFingerprint),
        s: parsed.sort,
        a: encodeDate(issuedAt, 'issued-at date'),
        e: encodeDate(expiresAt, 'expiry date'),
      };
      const unsignedJson = canonicalUnsignedWire(unsigned);
      const signature = createHmac('sha256', config.secret).update(unsignedJson, 'utf8').digest();
      const encoded = encodeBase64Url(JSON.stringify({ ...unsigned, sig: encodeBase64Url(signature) }));
      if (encoded.length > MAX_CURSOR_LENGTH) throw new TypeError('Encoded cursor exceeds the maximum length');
      return encoded;
    },

    decode(value: string, context: CursorContext): CursorDecodeResult {
      try {
        if (typeof value !== 'string' || value.length === 0) return invalid('malformed');
        if (value.length > MAX_CURSOR_LENGTH) return invalid('too-long');
        if (
          context.filterFingerprint.length === 0 ||
          context.filterFingerprint.length > MAX_CONTEXT_BINDING_LENGTH ||
          context.sort.length === 0 ||
          context.sort.length > 128
        ) return invalid('malformed');
        const binary = decodeBase64Url(value);
        if (binary === null) return invalid('malformed');
        let parsed: unknown;
        try {
          parsed = JSON.parse(binary.toString('utf8'));
        } catch {
          return invalid('malformed');
        }
        const wire = wireRecord(parsed);
        if (wire === null) {
          if (isRecord(parsed) && parsed.v === 1) return invalid('unsupported-version');
          return invalid('malformed');
        }
        if (!isValidSignature(wire.sig)) return invalid('signature');
        const unsignedJson = canonicalUnsignedWire(wire);
        if (!verifySignature(unsignedJson, wire.sig, keys)) return invalid('signature');
        if (!isListCursorKind(wire.k) || wire.k !== context.resource) return invalid('resource-mismatch');
        if (typeof wire.f !== 'string' || !/^[0-9a-f]{64}$/u.test(wire.f)) return invalid('invalid-payload');
        if (wire.f !== digestFilterBinding(context.filterFingerprint)) return invalid('filter-mismatch');
        if (wire.s !== context.sort) return invalid('sort-mismatch');
        const payload = candidatePayload(wire, context);
        if (payload === null) return invalid('invalid-payload');
        const now = context.now ?? new Date();
        if (!validDate(now)) return invalid('invalid-payload');
        const issuedAt = payload.issuedAt;
        const expiresAt = payload.expiresAt;
        if (issuedAt === undefined || expiresAt === undefined) return invalid('invalid-payload');
        if (expiresAt.getTime() <= issuedAt.getTime() || issuedAt.getTime() > now.getTime()) return invalid('invalid-payload');
        if (expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
        return { kind: 'valid', payload };
      } catch {
        // Cursor values are attacker-controlled transport input. Decode must
        // be total and never turn malformed bytes into a server error.
        return invalid('malformed');
      }
    },
  };
}

export function createSignedListCursorCodecFromEnv(
  env: EnvSource,
  options: CursorSigningConfigOptions = {},
): ListCursorCodec {
  return createSignedListCursorCodec(parseCursorSigningConfig(env, options));
}
