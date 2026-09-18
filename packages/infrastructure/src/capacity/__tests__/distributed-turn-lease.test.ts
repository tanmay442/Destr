import { describe, expect, it, afterEach } from 'vitest';
import {
  DistributedTurnLease,
  createInMemoryLeaseStore,
  turnLeaseKey,
  userLeasePrefix,
  acquireAsync,
  releaseAsync,
  countAsync,
  type LeaseStore,
  type MinimalRedis,
} from '../distributed-turn-lease';

const stores: LeaseStore[] = [];
const leases: DistributedTurnLease[] = [];
afterEach(() => {
  while (leases.length > 0) leases.pop()?.destroy();
  while (stores.length > 0) stores.pop()?.clear();
});

function createHarness(): { store: LeaseStore; now: { current: number } } {
  const now = { current: 3_000_000 };
  const store = createInMemoryLeaseStore({ now: () => now.current });
  stores.push(store);
  return { store, now };
}

function makeLease(store: LeaseStore, now: { current: number }, overrides: Record<string, unknown> = {}): DistributedTurnLease {
  let tokens = 0;
  const lease = new DistributedTurnLease({
    store,
    maxPerUser: 2,
    leaseTtlMs: 60_000,
    retryAfterMs: 1_000,
    now: () => now.current,
    newToken: () => `tok-${(tokens += 1)}`,
    ...overrides,
  });
  leases.push(lease);
  return lease;
}

describe('distributed-turn-lease keying', () => {
  it('scopes lease keys to tenant, user, and turn', () => {
    expect(turnLeaseKey('t1', 'u1', 'turn-9')).toBe('destr:turn-lease:t1:u1:turn-9');
    expect(turnLeaseKey('t1', 'u1', 'turn-9')).not.toBe(turnLeaseKey('t2', 'u1', 'turn-9'));
    expect(turnLeaseKey('t1', 'u1', 'turn-9')).not.toBe(turnLeaseKey('t1', 'u2', 'turn-9'));
    expect(userLeasePrefix('t1', 'u1')).toBe('destr:turn-lease:t1:u1:');
  });
});

describe('distributed-turn-lease across simulated instances', () => {
  it('shares the per-user ceiling across instances using one store', () => {
    const { store, now } = createHarness();
    void now;
    const a = makeLease(store, now);
    const b = makeLease(store, now);
    expect(a.acquire({ userId: 'u1', turnId: 'a-1' }).kind).toBe('acquired');
    expect(a.acquire({ userId: 'u1', turnId: 'a-2' }).kind).toBe('acquired');
    const cross = b.acquire({ userId: 'u1', turnId: 'b-1' });
    expect(cross.kind).toBe('rejected_per_user_limit');
    if (cross.kind !== 'rejected_per_user_limit') throw new Error('expected cross-instance rejection');
    expect(cross.retryAfterMs).toBe(1_000);
    expect(a.heldCount(undefined, 'u1')).toBe(2);
  });

  it('recovers expired leases so crashed instances cannot wedge the user', () => {
    const { store, now } = createHarness();
    const lease = makeLease(store, now, { leaseTtlMs: 5_000 });
    const first = lease.acquire({ userId: 'u-exp', turnId: 'e-1' });
    expect(first.kind).toBe('acquired');
    now.current += 10_000;
    expect(lease.heldCount(undefined, 'u-exp')).toBe(0);
    expect(lease.acquire({ userId: 'u-exp', turnId: 'e-2' }).kind).toBe('acquired');
    expect(lease.acquire({ userId: 'u-exp', turnId: 'e-3' }).kind).toBe('acquired');
  });

  it('holds a duplicate acquire for the same turn key', () => {
    const { store, now } = createHarness();
    const lease = makeLease(store, now, { maxPerUser: 8 });
    expect(lease.acquire({ userId: 'u-dup', turnId: 'same' }).kind).toBe('acquired');
    expect(lease.acquire({ userId: 'u-dup', turnId: 'same' }).kind).toBe('held');
  });
});

describe('distributed-turn-lease exactly-once release', () => {
  it.each(['completed', 'cancelled', 'disconnected', 'timeout', 'error'] as const)(
    'releases exactly once on %s',
    (outcome) => {
      const { store, now } = createHarness();
      const lease = makeLease(store, now);
      const acquired = lease.acquire({ userId: 'u-once', turnId: `once-${outcome}` });
      if (acquired.kind !== 'acquired') throw new Error('expected acquisition');
      const first = lease.release({ key: acquired.key, ownerToken: acquired.ownerToken, outcome });
      expect(first).toEqual({ kind: 'released', outcome });
      const second = lease.release({ key: acquired.key, ownerToken: acquired.ownerToken, outcome });
      expect(second.kind).toBe('already_released');
    },
  );

  it('rejects a wrong ownership token without releasing', () => {
    const { store, now } = createHarness();
    const lease = makeLease(store, now);
    const acquired = lease.acquire({ userId: 'u-tok', turnId: 'tok-1' });
    if (acquired.kind !== 'acquired') throw new Error('expected acquisition');
    expect(lease.release({ key: acquired.key, ownerToken: 'wrong', outcome: 'completed' }).kind)
      .toBe('token_mismatch');
    expect(lease.heldCount(undefined, 'u-tok')).toBe(1);
  });

  it('treats a late release after TTL recovery as idempotent', () => {
    const { store, now } = createHarness();
    const lease = makeLease(store, now, { leaseTtlMs: 1_000 });
    const acquired = lease.acquire({ userId: 'u-late', turnId: 'late-1' });
    if (acquired.kind !== 'acquired') throw new Error('expected acquisition');
    now.current += 5_000;
    expect(lease.release({ key: acquired.key, ownerToken: acquired.ownerToken, outcome: 'timeout' }).kind)
      .toBe('already_released');
  });

  it('renews only with the ownership token', () => {
    const { store, now } = createHarness();
    const lease = makeLease(store, now, { leaseTtlMs: 1_000 });
    const acquired = lease.acquire({ userId: 'u-ren', turnId: 'ren-1' });
    if (acquired.kind !== 'acquired') throw new Error('expected acquisition');
    expect(lease.renew({ key: acquired.key, ownerToken: 'wrong' })).toBe('token_mismatch');
    expect(lease.renew({ key: acquired.key, ownerToken: acquired.ownerToken })).toBe('renewed');
    now.current += 900;
    expect(lease.heldCount(undefined, 'u-ren')).toBe(1);
  });
});

describe('distributed-turn-lease store outage', () => {
  it('fails closed with store_unavailable instead of pretending admission', () => {
    const broken: LeaseStore = {
      name: 'memory',
      acquire(): never {
        throw new Error('store down');
      },
      release(): never {
        throw new Error('store down');
      },
      renew(): never {
        throw new Error('store down');
      },
      read(): null {
        return null;
      },
      count(): never {
        throw new Error('store down');
      },
      clear(): void {},
    };
    stores.push(broken);
    const lease = makeLease(broken, { current: 3_000_000 });
    const acquired = lease.acquire({ userId: 'u-x', turnId: 'x-1' });
    expect(acquired.kind).toBe('store_unavailable');
  });
});

function createFakeRedis(): MinimalRedis & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async set(key: string, value: string, opts?: { readonly nx?: boolean }): Promise<string | null> {
      if (opts?.nx === true && entries.has(key)) return null;
      entries.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return entries.delete(key) ? 1 : 0;
    },
    async scan(cursor: string, opts?: { readonly match?: string }): Promise<{ cursor: string; keys: string[] }> {
      void cursor;
      const prefix = (opts?.match ?? '*').replace(/\*$/, '');
      return { cursor: '0', keys: [...entries.keys()].filter((key) => key.startsWith(prefix)) };
    },
  };
}

describe('distributed-turn-lease redis helpers', () => {
  it('acquires once and compares-and-releases by token', async () => {
    const redis = createFakeRedis();
    expect(await acquireAsync(redis, 'k-1', 'tok-a', 60_000)).toBe('acquired');
    expect(await acquireAsync(redis, 'k-1', 'tok-b', 60_000)).toBe('held');
    expect(await releaseAsync(redis, 'k-1', 'tok-b')).toBe('token_mismatch');
    expect(await releaseAsync(redis, 'k-1', 'tok-a')).toBe('released');
    expect(await releaseAsync(redis, 'k-1', 'tok-a')).toBe('missing');
    expect(await countAsync(redis, 'destr:turn-lease:')).toBe(0);
  });
});
