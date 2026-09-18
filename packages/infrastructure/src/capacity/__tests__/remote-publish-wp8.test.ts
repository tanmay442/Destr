import { describe, expect, it, afterEach } from 'vitest';
import { configureLogger } from '@app/domain';
import { DurableBackgroundJobQueue } from '../background-job-queue';

/**
 * WP-8 B1: remotely-published jobs are owned by the remote worker. They must
 * not sit in the local dispatch buffer (no double execution, no depth
 * growth), while their idempotency keys still collapse repeats (bounded).
 */

const queues: DurableBackgroundJobQueue[] = [];
afterEach(() => {
  while (queues.length > 0) queues.pop()?.destroy();
  configureLogger('info');
});

function remoteJob(seq: number): Record<string, unknown> {
  return {
    jobId: `remote-${seq}`,
    idempotencyKey: `remote-key-${seq}`,
    kind: 'judge',
    turnId: `turn-${seq}`,
    payload: { question: 'q', answer: 'a' },
  };
}

describe('remote-delivery ownership', () => {
  it('keeps remotely-published jobs out of the local buffer', async () => {
    configureLogger('error');
    const published: unknown[] = [];
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      publish: async (job) => void published.push(job),
    });
    queues.push(queue);
    const stored = await queue.enqueue(remoteJob(1));
    expect(stored.kind).toBe('enqueued');
    if (stored.kind !== 'enqueued') return;
    expect(stored.durable).toBe(true);
    expect(published).toHaveLength(1);
    expect(queue.stats().depth).toBe(0);
    expect(queue.stats().remoteDeliveredTotal).toBe(1);
    let ran = 0;
    queue.registerHandler('judge', async () => {
      ran += 1;
    });
    const pumped = await queue.pump();
    expect(pumped).toMatchObject({ dispatched: 0, completed: 0, deadLettered: 0 });
    expect(ran).toBe(0);
  });

  it('collapses repeats by idempotency key without republishing', async () => {
    configureLogger('error');
    const published: unknown[] = [];
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      publish: async (job) => void published.push(job),
    });
    queues.push(queue);
    expect((await queue.enqueue(remoteJob(2))).kind).toBe('enqueued');
    const again = await queue.enqueue(remoteJob(2));
    expect(again.kind).toBe('duplicate');
    expect(published).toHaveLength(1);
    expect(queue.stats().duplicateTotal).toBe(1);
    expect(queue.stats().depth).toBe(0);
  });

  it('bounds delivered-key retention so depth can never grow monotonically', async () => {
    configureLogger('error');
    let publishes = 0;
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      publish: async () => {
        publishes += 1;
      },
    });
    queues.push(queue);
    for (let seq = 0; seq < 5_050; seq += 1) {
      const stored = await queue.enqueue(remoteJob(10_000 + seq));
      if (stored.kind !== 'enqueued') throw new Error('expected remote enqueue');
    }
    expect(queue.stats().depth).toBe(0);
    expect(queue.stats().remoteDeliveredTotal).toBe(5_050);
    // The earliest key was evicted: redelivery republishes (bounded memory
    // trades a rare duplicate remote run, still idempotent by turn).
    const before = publishes;
    const revived = await queue.enqueue(remoteJob(10_000));
    expect(revived.kind).toBe('enqueued');
    expect(publishes).toBe(before + 1);
    // A recent key still collapses.
    const recent = await queue.enqueue(remoteJob(10_000 + 5_049));
    expect(recent.kind).toBe('duplicate');
    expect(publishes).toBe(before + 1);
  });

  it('remote jobs bypass the buffer while shed jobs never orphan', async () => {
    configureLogger('error');
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      publish: async (job) => {
        if ((job as { jobId: string }).jobId === 'remote-3') return;
        throw new Error('unreachable in this test');
      },
    });
    queues.push(queue);
    // Remote-owned job: bypasses the buffer.
    expect((await queue.enqueue(remoteJob(3))).kind).toBe('enqueued');
    // Publish failure sheds without buffering (no orphan for the pump).
    const shed = await queue.enqueue({ ...remoteJob(4), jobId: 'shed-4', idempotencyKey: 'shed-4' });
    expect(shed.kind).toBe('shed');
    const pumped = await queue.pump();
    expect(pumped).toMatchObject({ dispatched: 0, completed: 0, deadLettered: 0 });
    expect(queue.stats().depth).toBe(0);
  });
});
