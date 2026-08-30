import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chunkIdentityPayload,
  createChunkUid,
  hashChunkContent,
  normalizeChunkContentHash,
} from '../stable-identities';

const identity = {
  documentUid: '4d7f5f90-7e4d-4a6f-8d9a-3cf7f1fd9c10',
  kind: 'child' as const,
  chunkIndex: 7,
  parentChunkIndex: 3,
  contentHash: 'a'.repeat(64),
};

describe('stable chunk identities', () => {
  it('returns the lowercase SHA-256 of the canonical identity payload', () => {
    const expected = createHash('sha256')
      .update(chunkIdentityPayload(identity), 'utf8')
      .digest('hex');

    expect(createChunkUid(identity)).toBe(expected);
    expect(createChunkUid(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a stable identity component changes', () => {
    const base = createChunkUid(identity);
    expect(createChunkUid({ ...identity, kind: 'parent' })).not.toBe(base);
    expect(createChunkUid({ ...identity, chunkIndex: 8 })).not.toBe(base);
    expect(createChunkUid({ ...identity, parentChunkIndex: null })).not.toBe(base);
    expect(createChunkUid({ ...identity, contentHash: 'b'.repeat(64) })).not.toBe(base);
    expect(createChunkUid({ ...identity, documentUid: '8e3f4c51-6a1c-4d30-9dd8-2e67ef86c015' })).not.toBe(base);
  });

  it('derives a content hash when one is absent and normalizes provided hashes', () => {
    expect(hashChunkContent('content')).toBe(
      createHash('sha256').update('content', 'utf8').digest('hex'),
    );
    expect(normalizeChunkContentHash('  ABC  ', 'content')).toBe('abc');
    expect(normalizeChunkContentHash(null, 'content')).toBe(hashChunkContent('content'));
  });
});
