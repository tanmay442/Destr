import { describe, expect, it } from 'vitest';
import {
  createListCursorContext,
  encodeListCursor,
  type CursorContext,
  type ListCursorPayload,
} from '@app/domain';
import { createSignedListCursorCodec } from './signed-cursor';

const issuedAt = new Date('2026-09-01T00:00:00.000Z');
const expiresAt = new Date('2026-09-01T00:15:00.000Z');
const config = {
  secret: 'current-signing-secret-with-at-least-32-bytes',
  ttlMs: 15 * 60 * 1000,
};

function documentContext(search = 'Alpha'): CursorContext {
  return createListCursorContext('documents', { search, includeDeleted: false });
}

function documentPayload(
  context: CursorContext,
  overrides: Partial<Omit<Extract<ListCursorPayload, { kind: 'documents' }>, 'kind'>> = {},
): ListCursorPayload {
  return {
    kind: 'documents',
    sortAt: new Date('2026-08-31T23:59:00.000Z'),
    id: 42,
    total: 120,
    filterFingerprint: context.filterFingerprint,
    sort: context.sort,
    issuedAt,
    expiresAt,
    ...overrides,
  };
}

function rewriteToken(token: string, mutate: (wire: Record<string, unknown>) => void): string {
  const wire = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(wire);
  return Buffer.from(JSON.stringify(wire)).toString('base64url');
}

describe('signed list cursor v2', () => {
  it('round-trips a filter-bound payload', () => {
    const codec = createSignedListCursorCodec(config);
    const context = documentContext();
    const payload = documentPayload(context);
    const encoded = codec.encode(payload);

    expect(encoded.length).toBeLessThanOrEqual(512);
    expect(codec.decode(encoded, { ...context, now: issuedAt })).toEqual({ kind: 'valid', payload });
  });

  it('normalizes filter key order and whitespace into one binding', () => {
    const first = createListCursorContext('documents', { includeDeleted: false, search: ' Alpha ' });
    const second = createListCursorContext('documents', { search: 'Alpha', includeDeleted: false });
    expect(first.filterFingerprint).toBe(second.filterFingerprint);
    expect(first.filterFingerprint).not.toBe(createListCursorContext('documents', { search: 'Beta', includeDeleted: false }).filterFingerprint);
  });

  it('rejects a one-byte payload mutation and a signature mutation', () => {
    const codec = createSignedListCursorCodec(config);
    const context = documentContext();
    const encoded = codec.encode(documentPayload(context));
    const payloadMutation = rewriteToken(encoded, (wire) => {
      wire.n = 121;
    });
    const signatureMutation = rewriteToken(encoded, (wire) => {
      const signature = String(wire.sig);
      wire.sig = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    });

    expect(codec.decode(payloadMutation, { ...context, now: issuedAt })).toEqual({ kind: 'invalid', reason: 'signature' });
    expect(codec.decode(signatureMutation, { ...context, now: issuedAt })).toEqual({ kind: 'invalid', reason: 'signature' });
  });

  it('rejects resource, filter, and sort mismatches after authenticating the token', () => {
    const codec = createSignedListCursorCodec(config);
    const context = documentContext();
    const encoded = codec.encode(documentPayload(context));

    expect(codec.decode(encoded, { ...createListCursorContext('tickets'), now: issuedAt })).toEqual({ kind: 'invalid', reason: 'resource-mismatch' });
    expect(codec.decode(encoded, { ...documentContext('Beta'), now: issuedAt })).toEqual({ kind: 'invalid', reason: 'filter-mismatch' });
    expect(codec.decode(encoded, { ...context, sort: 'uploadedAt:asc,id:asc', now: issuedAt })).toEqual({ kind: 'invalid', reason: 'sort-mismatch' });
  });

  it('rejects expired cursors and keeps totals authenticated', () => {
    const codec = createSignedListCursorCodec(config);
    const context = documentContext();
    const encoded = codec.encode(documentPayload(context));
    expect(codec.decode(encoded, { ...context, now: expiresAt })).toEqual({ kind: 'expired' });

    const forged = rewriteToken(encoded, (wire) => {
      wire.n = 9_999_999;
    });
    expect(codec.decode(forged, { ...context, now: issuedAt })).toEqual({ kind: 'invalid', reason: 'signature' });
  });

  it('accepts the previous key during rotation', () => {
    const oldCodec = createSignedListCursorCodec({ secret: 'previous-signing-secret-with-at-least-32-bytes', ttlMs: config.ttlMs });
    const rotatedCodec = createSignedListCursorCodec({
      secret: config.secret,
      previousSecret: 'previous-signing-secret-with-at-least-32-bytes',
      ttlMs: config.ttlMs,
    });
    const context = documentContext();
    const encoded = oldCodec.encode(documentPayload(context));
    expect(rotatedCodec.decode(encoded, { ...context, now: issuedAt }).kind).toBe('valid');
  });

  it('rejects legacy unsigned v1 cursors by policy', () => {
    const codec = createSignedListCursorCodec(config);
    const legacy = encodeListCursor({
      kind: 'documents',
      sortAt: new Date('2026-08-31T23:59:00.000Z'),
      id: 42,
      total: 120,
    });
    expect(codec.decode(legacy, { ...documentContext(), now: issuedAt })).toEqual({
      kind: 'invalid',
      reason: 'unsupported-version',
    });
  });

  it('returns controlled outcomes for oversized and random input without throwing', () => {
    const codec = createSignedListCursorCodec(config);
    const context = documentContext();
    expect(codec.decode('a'.repeat(513), context)).toEqual({ kind: 'invalid', reason: 'too-long' });
    for (const value of ['', 'not-base64', '\u0000\u0001', '%%%%', 'eyJ2IjoyfQ']) {
      expect(() => codec.decode(value, context)).not.toThrow();
      expect(codec.decode(value, context).kind).toBe('invalid');
    }
  });
});
