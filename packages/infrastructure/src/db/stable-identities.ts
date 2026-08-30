import { createHash } from 'node:crypto';
import type { Hasher } from '@app/domain';

export const defaultHasher: Hasher = {
  sha256: (buffer) => createHash('sha256').update(buffer).digest('hex'),
};

export type StableChunkKind = 'parent' | 'child' | 'summary';

export interface StableChunkIdentityInput {
  documentUid: string;
  kind: StableChunkKind;
  chunkIndex: number;
  parentChunkIndex: number | null;
  contentHash: string;
}

export function hashChunkContent(content: string, hasher: Hasher = defaultHasher): string {
  return hasher.sha256(Buffer.from(content, 'utf8')).toLowerCase();
}

export function normalizeChunkContentHash(
  contentHash: string | null | undefined,
  content: string,
  hasher: Hasher = defaultHasher,
): string {
  const normalized = contentHash?.trim();
  return normalized ? normalized.toLowerCase() : hashChunkContent(content, hasher);
}

export function chunkIdentityPayload(input: StableChunkIdentityInput): string {
  return [
    input.documentUid,
    input.kind,
    String(input.chunkIndex),
    input.parentChunkIndex == null ? '' : String(input.parentChunkIndex),
    input.contentHash,
  ].join('|');
}

export function createChunkUid(input: StableChunkIdentityInput, hasher: Hasher = defaultHasher): string {
  return hasher.sha256(Buffer.from(chunkIdentityPayload(input), 'utf8')).toLowerCase();
}
