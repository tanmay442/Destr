import { describe, expect, it, afterEach } from 'vitest';
import {
  DurableBackgroundJobQueue,
  resolveBackgroundJobMode,
} from '../background-job-queue';

const queues: DurableBackgroundJobQueue[] = [];
afterEach(() => {
  while (queues.length > 0) queues.pop()?.destroy();
});

function makeQueue(overrides: Record<string, unknown> = {}): {
  queue: DurableBackgroundJobQueue;
  now: { current: number };
} {
  const now = { current: 5_000_000 };
  const queue = new DurableBackgroundJobQueue({
    mode: 'qstash',
    maxDepth: 8,
    judgeMaxDepth: 4,
    maxConcurrent: 2,
    maxBacklogAgeMs: 60_000,
    retryAfterMs: 1_000,
    now: () => now.current,
    // Buffer mode (no remote publish): these suites pin local dispatch,
    // retry/DLQ, and backlog behavior. Remotely-published jobs are owned by
    // the remote worker and intentionally bypass the local buffer (see the
    // remote-delivery tests); the old no-op-publish setup encoded the
    // double-handling this change removes.
    ...overrides,
  });
  queues.push(queue);
  return { queue, now };
}

let jobSeq = 0;
function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  jobSeq += 1;
  return {
    jobId: `infra-job-${jobSeq}`,
    idempotencyKey: `infra-key-${jobSeq}`,
    kind: 'judge',
    ...overrides,
  };
}

describe('background-job-queue mode resolution', () => {
  it('uses durable qstash mode only when QSTASH env is present', () => {
    expect(resolveBackgroundJobMode({ QSTASH_TOKEN: 'tok' })).toBe('qstash');
    expect(resolveBackgroundJobMode({ QSTASH_TOKEN: '  ' })).toBe('disabled-safe');
    expect(resolveBackgroundJobMode({})).toBe(process.env.QSTASH_TOKEN ? 'qstash' : 'disabled-safe');
  });

  it('disabled-safe mode sheds visibly and observably instead of faking delivery', async () => {
    const queue = new DurableBackgroundJobQueue({ mode: 'disabled-safe', now: () => 0 });
    queues.push(queue);
    const result = await queue.enqueue(job({ jobId: 'ds-1', idempotencyKey: 'ds-1' }));
    expect(result.kind).toBe('shed');
    if (result.kind !== 'shed') throw new Error('expected disabled-safe shed');
    expect(result.reason).toBe('disabled');
    expect(queue.stats().mode).toBe('disabled-safe');
    expect(queue.stats().shedTotal).toBe(1);
    expect(queue.stats().depth).toBe(0);
  });
});

describe('background-job-queue durable dispatch', () => {
  it('dispatches through handlers with bounded concurrency and idempotent enqueue', async () => {
    const { queue } = makeQueue();
    const handled: string[] = [];
    queue.registerHandler('judge', async (item) => {
      handled.push(item.jobId);
    });
    expect((await queue.enqueue(job({ jobId: 'h-1', idempotencyKey: 'h-1' }))).kind).toBe('enqueued');
    const duplicate = await queue.enqueue(job({ jobId: 'h-2', idempotencyKey: 'h-1' }));
    expect(duplicate.kind).toBe('duplicate');
    const pumped = await queue.pump();
    expect(pumped).toEqual({ dispatched: 1, completed: 1, deadLettered: 0 });
    expect(handled).toEqual(['h-1']);
    expect(queue.stats().completedTotal).toBe(1);
  });

  it('retries failures then dead-letters with an observable record', async () => {
    const { queue } = makeQueue({ maxAttempts: 2 });
    queue.registerHandler('judge', async () => {
      throw new Error('grader 500');
    });
    await queue.enqueue(job({ jobId: 'f-1', idempotencyKey: 'f-1' }));
    expect((await queue.pump()).deadLettered).toBe(0);
    expect(queue.stats().depth).toBe(1);
    const second = await queue.pump();
    expect(second.deadLettered).toBe(1);
    expect(queue.stats().deadLetterTotal).toBe(1);
    expect(queue.stats().depth).toBe(0);
  });

  it('dead-letters handler-less judge jobs safely when judging is unavailable', async () => {
    const { queue } = makeQueue();
    await queue.enqueue(job({ jobId: 'nj-1', idempotencyKey: 'nj-1', kind: 'judge' }));
    const pumped = await queue.pump();
    expect(pumped.deadLettered).toBe(1);
    expect(queue.stats().deadLetterTotal).toBe(1);
  });

  it('sheds judge enqueues under interactive pressure and pauses independently', async () => {
    const { queue } = makeQueue();
    queue.setInteractivePressure(true);
    const shed = await queue.enqueue(job({ jobId: 'ip-1', idempotencyKey: 'ip-1', kind: 'judge' }));
    expect(shed.kind).toBe('shed');
    if (shed.kind !== 'shed') throw new Error('expected pressure shed');
    expect(shed.reason).toBe('interactive_pressure');
    queue.setInteractivePressure(false);
    queue.pause();
    expect((await queue.enqueue(job({ jobId: 'ip-2', idempotencyKey: 'ip-2' }))).kind).toBe('shed');
    queue.resume();
    expect((await queue.enqueue(job({ jobId: 'ip-3', idempotencyKey: 'ip-3' }))).kind).toBe('enqueued');
  });

  it('tracks backlog age so pressure is observable', async () => {
    const { queue, now } = makeQueue();
    await queue.enqueue(job({ jobId: 'ba-1', idempotencyKey: 'ba-1' }));
    expect(queue.stats().oldestAgeMs).toBe(0);
    expect(queue.stats().backlogStale).toBe(false);
    now.current += 61_000;
    expect(queue.stats().backlogStale).toBe(true);
  });

  it('surfaces remote publish failures as observable sheds, never silent drops', async () => {
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      now: () => 0,
      publish: async () => {
        throw new Error('qstash 503');
      },
    });
    queues.push(queue);
    const result = await queue.enqueue(job({ jobId: 'rp-1', idempotencyKey: 'rp-1' }));
    expect(result.kind).toBe('shed');
    if (result.kind !== 'shed') throw new Error('expected remote shed');
    expect(result.reason).toBe('remote_unavailable');
    expect(queue.stats().remotePublishFailures).toBe(1);
    expect(queue.stats().shedTotal).toBe(1);
  });
});
