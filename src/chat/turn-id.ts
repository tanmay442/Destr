const V4_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isV4Uuid(raw: unknown): raw is string {
  return typeof raw === 'string' && V4_UUID_REGEX.test(raw);
}

export function resolveTurnId(raw: unknown): string | null {
  return isV4Uuid(raw) ? raw : null;
}

export { V4_UUID_REGEX };
