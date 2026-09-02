export const MAX_CURSOR_LENGTH = 512;
/** Default lifetime used by the infrastructure signed-cursor adapter. */
export const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1000;

export type ListCursorKind = 'documents' | 'tickets' | 'users' | 'audit';

export type AdminListCursor =
  | { kind: 'documents'; sortAt: Date; id: number; total: number }
  | { kind: 'tickets'; sortAt: Date; id: number; total: number }
  | { kind: 'users'; sortAt: Date; clerkUserId: string; total: number }
  | { kind: 'audit'; sortAt: Date; id: number; total: number };

/**
 * The filter/sort binding carried by a signed cursor.  Timestamps are
 * optional at the domain boundary because the infrastructure codec supplies
 * issuance/expiry defaults when callers do not provide them explicitly.
 */
export type ListCursorPayload = AdminListCursor & {
  filterFingerprint: string;
  sort: string;
  issuedAt?: Date | undefined;
  expiresAt?: Date | undefined;
};

export interface CursorContext {
  /** Resource being paged; never inferred from untrusted cursor data. */
  resource: ListCursorKind;
  /** Canonical normalized filter binding; infrastructure hashes it before signing. */
  filterFingerprint: string;
  /** Stable description of the ordering, including tie-breaker direction. */
  sort: string;
  /** Optional clock supplied by deterministic callers/tests. */
  now?: Date | undefined;
}

export type CursorInvalidReason =
  | 'malformed'
  | 'too-long'
  | 'unsupported-version'
  | 'signature'
  | 'resource-mismatch'
  | 'filter-mismatch'
  | 'sort-mismatch'
  | 'invalid-payload';

export type CursorDecodeResult =
  | { kind: 'valid'; payload: ListCursorPayload }
  | { kind: 'invalid'; reason: CursorInvalidReason }
  | { kind: 'expired' };

/** Domain port implemented by an infrastructure adapter using authenticated signing. */
export interface ListCursorCodec {
  encode(payload: ListCursorPayload): string;
  decode(value: string, context: CursorContext): CursorDecodeResult;
}

export type CursorFilterValue = string | number | boolean | Date | null | undefined;
export type CursorFilters = Readonly<Record<string, CursorFilterValue>>;

export const LIST_CURSOR_SORTS = {
  documents: 'uploadedAt:desc,id:desc',
  tickets: 'createdAt:desc,id:desc',
  users: 'createdAt:asc,clerkUserId:asc',
  audit: 'at:desc,id:desc',
} as const satisfies Record<ListCursorKind, string>;

export function defaultListCursorSort(resource: ListCursorKind): string {
  switch (resource) {
    case 'documents':
      return LIST_CURSOR_SORTS.documents;
    case 'tickets':
      return LIST_CURSOR_SORTS.tickets;
    case 'users':
      return LIST_CURSOR_SORTS.users;
    case 'audit':
      return LIST_CURSOR_SORTS.audit;
    default: {
      const exhaustive: never = resource;
      return exhaustive;
    }
  }
}

function normalizeCursorFilterValue(value: CursorFilterValue): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('Cannot normalize an invalid cursor filter date');
    return value.toISOString();
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('Cannot normalize an unsafe numeric cursor filter');
    }
    return value;
  }
  return value;
}

/**
 * Normalize filter values and key order before binding them to a cursor.
 * Undefined keys are omitted, while null remains an intentional filter value.
 */
export function normalizeCursorFilters(filters: CursorFilters): Record<string, string | number | boolean | null> {
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(filters).sort()) {
    const value = normalizeCursorFilterValue(filters[key]);
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

/** Build the canonical context shared by application validation and repositories. */
export function createListCursorContext(
  resource: ListCursorKind,
  filters: CursorFilters = {},
  sort = defaultListCursorSort(resource),
): CursorContext {
  const normalized = normalizeCursorFilters(filters);
  const canonical = JSON.stringify({ resource, filters: normalized, sort: sort.trim() });
  return Object.freeze({
    resource,
    // Keep the canonical values in the domain context. The infrastructure
    // codec derives a collision-resistant SHA-256 digest for the wire token.
    filterFingerprint: canonical,
    sort: sort.trim(),
  });
}

/** Backwards-friendly short name for callers that already have a cursor context. */
export const createCursorContext = createListCursorContext;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCursorDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  return null;
}

function isValidCursorString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseCursorSafeInteger(value: unknown, positive: boolean): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (positive && value <= 0) return null;
  if (!positive && value < 0) return null;
  return value;
}

/** Parse a trusted-domain-shaped payload after a transport adapter validates its wire format. */
export function parseListCursorPayload(value: unknown): ListCursorPayload | null {
  if (!isRecord(value) || !isListCursorKind(value.kind)) return null;
  const sortAt = parseCursorDate(value.sortAt);
  const total = parseCursorSafeInteger(value.total, false);
  const filterFingerprint = value.filterFingerprint;
  const sort = value.sort;
  if (
    sortAt === null ||
    total === null ||
    !isValidCursorString(filterFingerprint, 4096) ||
    !isValidCursorString(sort, 128)
  ) return null;
  const parsedIssuedAt = value.issuedAt === undefined ? undefined : parseCursorDate(value.issuedAt);
  const parsedExpiresAt = value.expiresAt === undefined ? undefined : parseCursorDate(value.expiresAt);
  if ((value.issuedAt !== undefined && parsedIssuedAt === null) || (value.expiresAt !== undefined && parsedExpiresAt === null)) return null;
  const issuedAt = parsedIssuedAt === null ? undefined : parsedIssuedAt;
  const expiresAt = parsedExpiresAt === null ? undefined : parsedExpiresAt;

  if (value.kind === 'users') {
    if (!isValidCursorString(value.clerkUserId, 255)) return null;
    return {
      kind: 'users',
      sortAt,
      clerkUserId: value.clerkUserId,
      total,
      filterFingerprint,
      sort,
      ...(issuedAt !== undefined ? { issuedAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  const id = parseCursorSafeInteger(value.id, true);
  if (id === null) return null;
  const common = {
    sortAt,
    id,
    total,
    filterFingerprint,
    sort,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  if (value.kind === 'documents') return { kind: 'documents', ...common };
  if (value.kind === 'tickets') return { kind: 'tickets', ...common };
  return { kind: 'audit', ...common };
}

export function isListCursorPayload(value: unknown): value is ListCursorPayload {
  return parseListCursorPayload(value) !== null;
}

type EncodedCursor =
  | { v: 1; k: 'documents' | 'tickets' | 'audit'; t: string; i: number; n: number }
  | { v: 1; k: 'users'; t: string; i: string; n: number };

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

export function isListCursorKind(value: unknown): value is ListCursorKind {
  return value === 'documents' || value === 'tickets' || value === 'users' || value === 'audit';
}

const isCursorKind = isListCursorKind;

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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function encodeTotal(value: number): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TypeError('Cannot encode a cursor with an invalid total');
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
        n: encodeTotal(cursor.total),
      };
      break;
    case 'tickets':
      payload = {
        v: 1,
        k: 'tickets',
        t: encodeSortAt(cursor.sortAt),
        i: encodeNumericTieBreaker(cursor.id),
        n: encodeTotal(cursor.total),
      };
      break;
    case 'users':
      payload = {
        v: 1,
        k: 'users',
        t: encodeSortAt(cursor.sortAt),
        i: encodeStringTieBreaker(cursor.clerkUserId),
        n: encodeTotal(cursor.total),
      };
      break;
    case 'audit':
      payload = {
        v: 1,
        k: 'audit',
        t: encodeSortAt(cursor.sortAt),
        i: encodeNumericTieBreaker(cursor.id),
        n: encodeTotal(cursor.total),
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
  if (sortAt === null || !isNonNegativeSafeInteger(parsed.n)) return null;

  if (parsed.k === 'users') {
    if (typeof parsed.i !== 'string' || !isValidTieBreaker(parsed.i)) return null;
    return { kind: 'users', sortAt, clerkUserId: parsed.i, total: parsed.n };
  }
  if (!isPositiveSafeInteger(parsed.i)) return null;
  return { kind: parsed.k, sortAt, id: parsed.i, total: parsed.n };
}
