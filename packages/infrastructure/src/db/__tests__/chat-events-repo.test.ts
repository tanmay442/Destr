import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatEventBatcher } from '../chat-events-repo';
import { chatEvents, auditDeadLetter } from '../schema';
import type { ChatEventInput } from '@app/domain';

type Insert = { table: unknown; values: unknown[] };

function makeFakeClient(opts: { failChatInsert?: boolean } = {}) {
  const inserts: Insert[] = [];
  const deleted: { userId?: string } = {};
  const client = {
    insert(table: unknown) {
      return {
        async values(values: unknown[]) {
          if (table === chatEvents && opts.failChatInsert) throw new Error('insert boom');
          inserts.push({ table, values });
        },
      };
    },
    delete() {
      return {
        where() {
          return {
            async returning() {
              return [{ id: 1 }, { id: 2 }];
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: { userId?: string }) {
          deleted.userId = patch.userId;
          return {
            where() {
              return {
                async returning() {
                  return [{ id: 7 }];
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as never, inserts, deleted };
}

const sample: ChatEventInput = { userId: 'u1', query: 'q', mode: 'vector' };

describe('ChatEventBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('buffers records and flushes them as one insert', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    batcher.record({ ...sample, mode: 'agentic' });
    expect(inserts).toHaveLength(0);
    await batcher.flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(chatEvents);
    expect(inserts[0]!.values).toHaveLength(2);
  });

  it('auto-flushes when the buffer reaches the max size', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    for (let i = 0; i < 100; i++) batcher.record(sample);
    await vi.runOnlyPendingTimersAsync();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toHaveLength(100);
  });

  it('auto-flushes on the interval timer', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inserts).toHaveLength(1);
  });

  it('dead-letters the batch when the primary insert fails', async () => {
    const { client, inserts } = makeFakeClient({ failChatInsert: true });
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    await batcher.flush();
    const dl = inserts.find((i) => i.table === auditDeadLetter);
    expect(dl).toBeDefined();
    expect((dl!.values as { kind: string }).kind).toBe('chat_event');
    expect((dl!.values as { payload: unknown[] }).payload).toHaveLength(1);
  });

  it('flush is a no-op on an empty buffer', async () => {
    const { client, inserts } = makeFakeClient();
    await new ChatEventBatcher(client).flush();
    expect(inserts).toHaveLength(0);
  });

  it('purgeUserData deletes and reports the count', async () => {
    const { client } = makeFakeClient();
    const result = await new ChatEventBatcher(client).purgeUserData('u1');
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('purgeOlderThan deletes and reports the count', async () => {
    const { client } = makeFakeClient();
    const result = await new ChatEventBatcher(client).purgeOlderThan(new Date());
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('anonymizeUserData redacts the user and reports the count', async () => {
    const { client, deleted } = makeFakeClient();
    const result = await new ChatEventBatcher(client).anonymizeUserData('u1');
    expect(result).toEqual({ updatedCount: 1 });
    expect(deleted.userId).toBe('REDACTED');
  });
});
