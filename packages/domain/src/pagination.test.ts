import { describe, expect, it } from 'vitest';
import { decodeListCursor, encodeListCursor } from './pagination';

function encodePayload(payload: unknown): string {
  return btoa(JSON.stringify(payload))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

describe('list cursors', () => {
  it('round-trips compound numeric keys for equal timestamps', () => {
    const timestamp = new Date('2026-04-01T12:00:00.000Z');
    const encoded = encodeListCursor({ kind: 'documents', sortAt: timestamp, id: 42, total: 120 });

    expect(decodeListCursor(encoded, 'documents')).toEqual({
      kind: 'documents',
      sortAt: timestamp,
      id: 42,
      total: 120,
    });
  });

  it('round-trips the string tie-breaker used by users', () => {
    const timestamp = new Date('2026-04-01T12:00:00.000Z');
    const encoded = encodeListCursor({ kind: 'users', sortAt: timestamp, clerkUserId: 'user_42', total: 120 });

    expect(decodeListCursor(encoded, 'users')).toEqual({
      kind: 'users',
      sortAt: timestamp,
      clerkUserId: 'user_42',
      total: 120,
    });
  });

  it('rejects malformed and wrong-kind payloads', () => {
    const documentsCursor = encodeListCursor({
      kind: 'documents',
      sortAt: new Date('2026-04-01T12:00:00.000Z'),
      id: 42,
      total: 120,
    });
    const malformed = encodePayload({ v: 1, k: 'documents', t: 'not-a-date', i: 42 });

    expect(decodeListCursor('not a cursor', 'documents')).toBeNull();
    expect(decodeListCursor(malformed, 'documents')).toBeNull();
    expect(decodeListCursor(documentsCursor, 'tickets')).toBeNull();
  });
});
