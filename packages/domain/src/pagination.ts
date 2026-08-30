export const MAX_CURSOR_LENGTH = 512;

export type ListCursorKind = 'documents' | 'tickets' | 'users' | 'audit';

export type AdminListCursor =
  | { kind: 'documents'; sortAt: Date; id: number }
  | { kind: 'tickets'; sortAt: Date; id: number }
  | { kind: 'users'; sortAt: Date; clerkUserId: string }
  | { kind: 'audit'; sortAt: Date; id: number };

type EncodedCursor =
  | { v: 1; k: 'documents' | 'tickets' | 'audit'; t: string; i: number }
  | { v: 1; k: 'users'; t: string; i: string };

declare function btoa(data: string): string;
declare function atob(data: string): string;

function encodeUtf8(value: string): string {
  return encodeURIComponent(value).replace(
    /%([0-9A-F]{2})/g,
    (_match: string, byte: string) => String.fromCharCode(Number.parseInt(byte, 16)),
  );
}

function decodeUtf8(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    encoded += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return decodeURIComponent(encoded);
}

function encodeBase64Url(value: string): string {
  return btoa(encodeUtf8(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCursorKind(value: unknown): value is ListCursorKind {
  return value === 'documents' || value === 'tickets' || value === 'users' || value === 'audit';
}

function parseSortAt(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isValidTieBreaker(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function encodeSortAt(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Cannot encode a cursor with an invalid sort date');
  }
  return value.toISOString();
}

function encodeNumericTieBreaker(value: number): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TypeError('Cannot encode a cursor with an invalid numeric tie-breaker');
  }
  return value;
}

function encodeStringTieBreaker(value: string): string {
  if (!isValidTieBreaker(value)) {
    throw new TypeError('Cannot encode a cursor with an invalid string tie-breaker');
  }
  return value;
}

export function encodeListCursor(cursor: AdminListCursor): string {
  let payload: EncodedCursor;
  switch (cursor.kind) {
    case 'documents':
      payload = {
        v: 1,
        k: 'documents',
        t: encodeSortAt(cursor.sortAt),
        i: encodeNumericTieBreaker(cursor.id),
      };
      break;
    case 'tickets':
      payload = {
        v: 1,
        k: 'tickets',
        t: encodeSortAt(cursor.sortAt),
        i: encodeNumericTieBreaker(cursor.id),
      };
      break;
    case 'users':
      payload = {
        v: 1,
        k: 'users',
        t: encodeSortAt(cursor.sortAt),
        i: encodeStringTieBreaker(cursor.clerkUserId),
      };
      break;
    case 'audit':
      payload = {
        v: 1,
        k: 'audit',
        t: encodeSortAt(cursor.sortAt),
        i: encodeNumericTieBreaker(cursor.id),
      };
      break;
    default: {
      const exhaustive: never = cursor;
      return exhaustive;
    }
  }
  return encodeBase64Url(JSON.stringify(payload));
}

export function decodeListCursor(raw: unknown, expectedKind: 'documents'): Extract<AdminListCursor, { kind: 'documents' }> | null;
export function decodeListCursor(raw: unknown, expectedKind: 'tickets'): Extract<AdminListCursor, { kind: 'tickets' }> | null;
export function decodeListCursor(raw: unknown, expectedKind: 'users'): Extract<AdminListCursor, { kind: 'users' }> | null;
export function decodeListCursor(raw: unknown, expectedKind: 'audit'): Extract<AdminListCursor, { kind: 'audit' }> | null;
export function decodeListCursor(raw: unknown, expectedKind?: ListCursorKind): AdminListCursor | null;
export function decodeListCursor(
  raw: unknown,
  expectedKind?: ListCursorKind,
): AdminListCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  const binary = decodeBase64Url(raw);
  if (binary === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(binary));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    !isCursorKind(parsed.k) ||
    (expectedKind !== undefined && parsed.k !== expectedKind)
  ) {
    return null;
  }
  const sortAt = parseSortAt(parsed.t);
  if (sortAt === null) return null;

  if (parsed.k === 'users') {
    if (typeof parsed.i !== 'string' || !isValidTieBreaker(parsed.i)) return null;
    return { kind: 'users', sortAt, clerkUserId: parsed.i };
  }
  if (!isPositiveSafeInteger(parsed.i)) return null;
  return { kind: parsed.k, sortAt, id: parsed.i };
}
