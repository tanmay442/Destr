import {
  CHAT_FILE_MAX_FILENAME_LENGTH,
  CHAT_FILE_MAX_URL_LENGTH,
} from '@app/domain';

export const CHAT_FILE_MEDIA_TYPES = [
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type ChatFileMediaType = (typeof CHAT_FILE_MEDIA_TYPES)[number];

export type ValidatedChatFile = {
  type: 'file';
  url: string;
  filename?: string;
  mediaType: ChatFileMediaType;
};

export type ChatFileValidationResult =
  | { kind: 'valid'; file: ValidatedChatFile }
  | { kind: 'invalid'; reason: string };

export type ChatFileUrlValidationResult =
  | { kind: 'valid'; url: URL }
  | { kind: 'invalid'; reason: string };

function isBlockedIpv4(host: string): boolean {
  const segments = host.split('.');
  if (segments.length !== 4) return false;
  const octets = segments.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return true;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const firstGroup = Number.parseInt(normalized.split(':')[0] ?? '', 16);
  if (Number.isFinite(firstGroup) && firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;
  const mappedDottedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedDottedIpv4 !== undefined) return isBlockedIpv4(mappedDottedIpv4);
  // WHATWG URL canonicalization rewrites mapped dotted IPv4 literals such as
  // ::ffff:127.0.0.1 to ::ffff:7f00:1. Decode the final 32 bits before
  // applying the IPv4 policy so canonicalization cannot bypass it.
  const mappedHexIpv4 = normalized.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexIpv4) {
    const high = Number.parseInt(mappedHexIpv4[1]!, 16);
    const low = Number.parseInt(mappedHexIpv4[2]!, 16);
    return isBlockedIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  // Reject deprecated IPv4-compatible, site-local, and multicast ranges.
  if (normalized.startsWith('::') || normalized.startsWith('ff')) return true;
  if (Number.isFinite(firstGroup) && firstGroup >= 0xfec0 && firstGroup <= 0xfeff) return true;
  return false;
}

function isAllowedMediaType(value: string): value is ChatFileMediaType {
  return CHAT_FILE_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

export function validateChatFileUrl(input: {
  url: string;
  allowedOrigins?: ReadonlySet<string> | undefined;
}): ChatFileUrlValidationResult {
  const url = input.url.trim();
  if (url.length === 0 || url.length > CHAT_FILE_MAX_URL_LENGTH) {
    return { kind: 'invalid', reason: 'File URL is empty or too long' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid', reason: 'File URL is invalid' };
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '') {
    return { kind: 'invalid', reason: 'File URL scheme or credentials are not allowed' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === ''
    || host === 'localhost'
    || host.endsWith('.localhost')
    || isBlockedIpv4(host)
    || isBlockedIpv6(host)
  ) {
    return { kind: 'invalid', reason: 'File URL host is not allowed' };
  }
  if (input.allowedOrigins !== undefined && !input.allowedOrigins.has(parsed.origin)) {
    return { kind: 'invalid', reason: 'File URL origin is not allowed' };
  }
  return { kind: 'valid', url: parsed };
}

export function validateChatFile(input: {
  url: string;
  filename?: string | undefined;
  mediaType?: string | undefined;
  allowedOrigins?: ReadonlySet<string> | undefined;
}): ChatFileValidationResult {
  if (input.filename !== undefined && input.filename.length > CHAT_FILE_MAX_FILENAME_LENGTH) {
    return { kind: 'invalid', reason: 'File name is too long' };
  }
  const mediaType = input.mediaType?.toLowerCase();
  if (mediaType === undefined || !isAllowedMediaType(mediaType)) {
    return { kind: 'invalid', reason: 'File media type is not supported' };
  }
  const urlResult = validateChatFileUrl({
    url: input.url,
    ...(input.allowedOrigins !== undefined ? { allowedOrigins: input.allowedOrigins } : {}),
  });
  if (urlResult.kind === 'invalid') return urlResult;

  return {
    kind: 'valid',
    file: {
      type: 'file',
      url: urlResult.url.href,
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
      mediaType,
    },
  };
}
