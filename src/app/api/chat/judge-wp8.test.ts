import { describe, it, expect, vi } from 'vitest';
import { DurableBackgroundJobQueue } from '@app/infrastructure/capacity/background-job-queue';
import {
  decodeJudgePayload,
  encodeJudgePayload,
  judgeIdempotencyKey,
  judgeJobId,
} from '@app/application/capacity/background-queue';
import {
  createJudgeScheduler,
  createQualityJudge,
  type JudgeQueuePort,
  type JudgeTaskContext,
} from './judge';

/**
 * WP-8 F-39: the durable judge seam pins both paths. Flag off (or no queue)
 * behaves exactly like the pre-WP-8 after()/inline dispatch; flag on
 * enqueues serializable judge jobs and pumps the queue, falling back inline
 * when the queue sheds or fails.
 */

vi.mock('next/server', () => ({
  after: (task: () => void) => task(),
}));

const CTX: JudgeTaskContext = {
  question: 'How do I reset my password?',
  snippets: ['Reset it in settings.'],
  documents: 'Reset it in settings.',
  answer: 'Reset it in settings.',
  turnId: 'turn-1',
};

function fakeQueue(outcome: 'enqueued' | 'shed' | 'throw' = 'enqueued'): JudgeQueuePort & {
  enqueued: unknown[];
  pumped: number;
} {
  const state = {
    enqueued: [] as unknown[],
    pumped: 0,
    async enqueue(job: unknown) {
      if (outcome === 'throw') throw new Error('queue down');
      if (outcome === 'shed') return { kind: 'shed' as const, reason: 'queue_full', durable: false as const };
      state.enqueued.push(job);
      return { kind: 'enqueued' as const, durable: false as const };
    },
    async pump() {
      state.pumped += 1;
      return { dispatched: 0, completed: 0, deadLettered: 0 };
    },
  };
  return state;
}

describe('durable judge seam', () => {
  it('runs inline through scheduleAfter when the flag is off', async () => {
    const scheduled: Array<() => void> = [];
    const schedule = createJudgeScheduler({
      enabled: false,
      queue: fakeQueue(),
      scheduleAfter: (task) => void scheduled.push(task),
    });
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({ enabled: false, queue: fakeQueue(), runInline: inline });
    let executed = false;
    schedule(() => judge(CTX).then(() => {
      executed = true;
    }));
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();
    // Flush the scheduler's async wrapper.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toBe(true);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('enqueues a serializable judge job and pumps when the flag is on', async () => {
    const queue = fakeQueue('enqueued');
    const scheduled: Array<() => void> = [];
    const schedule = createJudgeScheduler({
      enabled: true,
      queue,
      scheduleAfter: (task) => void scheduled.push(task),
    });
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({ enabled: true, queue, runInline: inline });
    schedule(() => judge(CTX));
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      kind: 'judge',
      turnId: 'turn-1',
      payload: {
        question: CTX.question,
        snippets: CTX.snippets,
        documents: CTX.documents,
        answer: CTX.answer,
      },
    });
    expect(() => JSON.stringify(queue.enqueued[0])).not.toThrow();
    expect(queue.pumped).toBe(1);
    expect(inline).not.toHaveBeenCalled();
  });

  it('falls back inline when the queue sheds', async () => {
    const queue = fakeQueue('shed');
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({ enabled: true, queue, runInline: inline });
    await judge(CTX);
    expect(queue.enqueued).toHaveLength(0);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('falls back inline when the queue throws', async () => {
    const queue = fakeQueue('throw');
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({ enabled: true, queue, runInline: inline });
    await judge(CTX);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('runs inline when the flag is on but no queue is configured', async () => {
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({ enabled: true, queue: undefined, runInline: inline });
    await judge(CTX);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('skips the local pump for remotely-published jobs (no double judge cost)', async () => {
    const remoteQueue: JudgeQueuePort = {
      enqueue: async () => ({ kind: 'enqueued', durable: true }),
      pump: vi.fn(async () => ({ dispatched: 0, completed: 0, deadLettered: 0 })),
    };
    let reported = false;
    const scheduled: Array<() => void> = [];
    const schedule = createJudgeScheduler({
      enabled: true,
      queue: remoteQueue,
      scheduleAfter: (task) => void scheduled.push(task),
      isDurable: () => reported,
    });
    const inline = vi.fn(async () => undefined);
    const judge = createQualityJudge({
      enabled: true,
      queue: remoteQueue,
      reportDurable: (durable) => {
        reported = durable;
      },
      runInline: inline,
    });
    schedule(() => judge(CTX));
    await scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toBe(true);
    expect(inline).not.toHaveBeenCalled();
    expect(remoteQueue.pump).not.toHaveBeenCalled();
  });
});

describe('durable judge production shape (real queue)', () => {
  it('enqueues the port shape through the real DurableBackgroundJobQueue and runs the decoded payload', async () => {
    // No QSTASH_TOKEN here, so construct buffer mode explicitly: the same
    // validation path as production, without remote delivery.
    const queue = new DurableBackgroundJobQueue({ mode: 'qstash' });
    try {
      const payload = { question: CTX.question, snippets: CTX.snippets, documents: CTX.documents, answer: CTX.answer };
      const stored = await queue.enqueue({
        jobId: judgeJobId(CTX.turnId),
        idempotencyKey: judgeIdempotencyKey(CTX.turnId),
        kind: 'judge',
        turnId: CTX.turnId,
        payload: encodeJudgePayload(payload),
      });
      expect(stored.kind).toBe('enqueued');
      if (stored.kind !== 'enqueued') return;
      expect(stored.durable).toBe(false);
      // Repeat delivery of the same turn collapses by idempotency key while
      // the original is still pending.
      const again = await queue.enqueue({
        jobId: judgeJobId(CTX.turnId),
        idempotencyKey: judgeIdempotencyKey(CTX.turnId),
        kind: 'judge',
        turnId: CTX.turnId,
        payload: encodeJudgePayload(payload),
      });
      expect(again.kind).toBe('duplicate');
      const seen: Array<{ turnId: string | undefined; payload: unknown }> = [];
      queue.registerHandler('judge', async (job) => {
        seen.push({ turnId: job.turnId, payload: job.payload });
      });
      const pumped = await queue.pump();
      expect(pumped).toMatchObject({ dispatched: 1, completed: 1, deadLettered: 0 });
      expect(seen).toHaveLength(1);
      const decoded = decodeJudgePayload(seen[0]?.payload);
      expect(decoded).toMatchObject({
        question: CTX.question,
        snippets: CTX.snippets,
        documents: CTX.documents,
        answer: CTX.answer,
      });
    } finally {
      queue.destroy();
    }
  });

  it('marks remotely-published jobs durable (local pump skips them)', async () => {
    const published: unknown[] = [];
    const queue = new DurableBackgroundJobQueue({
      mode: 'qstash',
      publish: async (job) => {
        published.push(job);
      },
    });
    try {
      const stored = await queue.enqueue({
        jobId: judgeJobId(CTX.turnId),
        idempotencyKey: judgeIdempotencyKey(CTX.turnId),
        kind: 'judge',
        turnId: CTX.turnId,
        payload: encodeJudgePayload({
          question: CTX.question,
          snippets: CTX.snippets,
          documents: CTX.documents,
          answer: CTX.answer,
        }),
      });
      expect(stored.kind).toBe('enqueued');
      if (stored.kind !== 'enqueued') return;
      expect(stored.durable).toBe(true);
      expect(published).toHaveLength(1);
      // B1: remotely-published jobs must not sit in the local dispatch
      // buffer (no double execution, no depth growth).
      expect(queue.stats().depth).toBe(0);
      expect(queue.stats().remoteDeliveredTotal).toBe(1);
      let ran = 0;
      queue.registerHandler('judge', async () => {
        ran += 1;
      });
      const pumped = await queue.pump();
      expect(pumped).toMatchObject({ dispatched: 0, completed: 0, deadLettered: 0 });
      expect(ran).toBe(0);
    } finally {
      queue.destroy();
    }
  });

  it('rejects unencoded array payloads at the real queue boundary', async () => {
    const queue = new DurableBackgroundJobQueue({ mode: 'qstash' });
    try {
      await expect(
        queue.enqueue({
          jobId: 'judge-x',
          idempotencyKey: 'judge-turn:x',
          kind: 'judge',
          turnId: 'x',
          payload: { question: 'q', snippets: ['a'], documents: 'd', answer: 'a' },
        }),
      ).rejects.toThrow();
    } finally {
      queue.destroy();
    }
  });
});
