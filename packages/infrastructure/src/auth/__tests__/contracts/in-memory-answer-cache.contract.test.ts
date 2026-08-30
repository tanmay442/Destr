import { describe, expect, it } from 'vitest';
import { createInMemoryAnswerCache } from '../../in-memory-answer-cache';
import { runAnswerCacheContract } from './answer-cache-contract';

describe('in-memory answer cache contract', () => {
  runAnswerCacheContract(createInMemoryAnswerCache);

  it('does not allow a stale token to release a newer lease', async () => {
    const cache = createInMemoryAnswerCache();
    const firstToken = await cache.lease?.tryAcquire('same-key', 60);
    expect(firstToken).toEqual(expect.any(String));
    await cache.lease?.release('same-key', 'stale-token');
    expect(await cache.lease?.tryAcquire('same-key', 60)).toBeNull();
    await cache.lease?.release('same-key', firstToken!);
    expect(await cache.lease?.tryAcquire('same-key', 60)).toEqual(expect.any(String));
  });
});
