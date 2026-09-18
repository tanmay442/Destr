import { describe, expect, it, afterEach } from 'vitest';
import { createBackgroundJobQueue, type BackgroundJobQueue } from '../background-queue';

const queues: BackgroundJobQueue[] = [];
afterEach(() => {
  while (queues.length > 0) {
    const queue = queues.pop();
    queue?.destroy();
  }
});

function makeQueue(overrides: Record<string, unknown> = {}): { queue: BackgroundJobQueue; now: { current: number } } {
  const now = { current: 2_000_000 };
  let ids = 0;
  const queue = createBackgroundJobQueue({
    config: {
      maxDepth: 4,
      judgeMaxDepth: 2,
      retryDelaysMs: [1_000, 5_000],
      maxBacklogAgeMs: 60_000,
      retryAfterMs: 1_000,
      completedKeyRetention: 100,
      ...overrides,
    },
    now: () => now.current,
    newId: () => `job-${(ids += 1)}`,
  });
  queues.push(queue);
  return { queue, now };
}

let jobSeq = 0;
function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  jobSeq += 1;
  return {
    jobId: `job-${jobSeq}`,
    idempotencyKey: `key-${jobSeq}`,
    kind: 'judge',
    ...overrides,
  };
}

describe('background-queue enqueue policy', () => {
  it('enqueues within bounds and reports position', () => {
    const { queue } = makeQueue();
    const first = queue.enqueue(job({ jobId: 'j-1', idempotencyKey: 'k-1' }));
    expect(first).toEqual({ kind: 'enqueued', jobId: 'j-1', position: 1 });
    expect(queue.stats().depth).toBe(1);
  });

  it('collapses duplicate idempotency keys without double work', () => {
    const { queue } = makeQueue();
    expect(queue.enqueue(job({ jobId: 'j-1', idempotencyKey: 'same' })).kind).toBe('enqueued');
    const duplicate = queue.enqueue(job({ jobId: 'j-2', idempotencyKey: 'same' }));
    expect(duplicate).toEqual({ kind: 'duplicate', jobId: 'j-1' });
    expect(queue.stats().depth).toBe(1);
    expect(queue.complete('j-1')).toBe(true);
    const afterComplete = queue.enqueue(job({ jobId: 'j-3', idempotencyKey: 'same' }));
    expect(afterComplete.kind).toBe('duplicate');
  });

  it('sheds visibly when the queue is full or the judge reservation is exhausted', () => {
    const { queue } = makeQueue();
    expect(queue.enqueue(job({ jobId: 'a', idempotencyKey: 'a', kind: 'analytics' })).kind).toBe('enqueued');
    expect(queue.enqueue(job({ jobId: 'b', idempotencyKey: 'b', kind: 'analytics' })).kind).toBe('enqueued');
    expect(queue.enqueue(job({ jobId: 'j1', idempotencyKey: 'j1', kind: 'judge' })).kind).toBe('enqueued');
    expect(queue.enqueue(job({ jobId: 'j2', idempotencyKey: 'j2', kind: 'judge' })).kind).toBe('enqueued');
    const shedJudge = queue.enqueue(job({ jobId: 'j3', idempotencyKey: 'j3', kind: 'judge' }));
    expect(shedJudge.kind).toBe('shed');
    if (shedJudge.kind !== 'shed') throw new Error('expected judge reservation shed');
    expect(shedJudge.reason).toBe('queue_full');
    expect(shedJudge.retryAfterMs).toBe(1_000);
    const shedAll = queue.enqueue(job({ jobId: 'c', idempotencyKey: 'c', kind: 'analytics' }));
    expect(shedAll.kind).toBe('shed');
    expect(queue.stats().shedTotal).toBe(2);
  });

  it('sheds judge jobs first under interactive pressure, preserving interactive capacity', () => {
    const { queue } = makeQueue();
    queue.setInteractivePressure(true);
    const judge = queue.enqueue(job({ jobId: 'jp', idempotencyKey: 'jp', kind: 'judge' }));
    expect(judge.kind).toBe('shed');
    if (judge.kind !== 'shed') throw new Error('expected interactive-pressure shed');
    expect(judge.reason).toBe('interactive_pressure');
    const analytics = queue.enqueue(job({ jobId: 'ap', idempotencyKey: 'ap', kind: 'analytics' }));
    expect(analytics.kind).toBe('enqueued');
    queue.setInteractivePressure(false);
    expect(queue.enqueue(job({ jobId: 'jp2', idempotencyKey: 'jp2', kind: 'judge' })).kind).toBe('enqueued');
  });

  it('sheds visibly while paused or disabled and resumes cleanly', () => {
    const { queue } = makeQueue();
    queue.pause();
    const paused = queue.enqueue(job({ jobId: 'p1', idempotencyKey: 'p1' }));
    expect(paused.kind).toBe('shed');
    if (paused.kind !== 'shed') throw new Error('expected paused shed');
    expect(paused.reason).toBe('paused');
    queue.resume();
    queue.disable();
    const disabled = queue.enqueue(job({ jobId: 'p2', idempotencyKey: 'p2' }));
    expect(disabled.kind).toBe('shed');
    if (disabled.kind !== 'shed') throw new Error('expected disabled shed');
    expect(disabled.reason).toBe('disabled');
    queue.enable();
    expect(queue.enqueue(job({ jobId: 'p3', idempotencyKey: 'p3' })).kind).toBe('enqueued');
  });

  it('sheds judge work when judging is unavailable without touching interactive work', () => {
    const { queue } = makeQueue();
    queue.setJudgeAvailable(false);
    const shed = queue.enqueue(job({ jobId: 'ju', idempotencyKey: 'ju', kind: 'judge' }));
    expect(shed.kind).toBe('shed');
    if (shed.kind !== 'shed') throw new Error('expected judge-unavailable shed');
    expect(shed.reason).toBe('judge_unavailable');
    expect(queue.enqueue(job({ jobId: 'au', idempotencyKey: 'au', kind: 'analytics' })).kind).toBe('enqueued');
  });
});

describe('background-queue retries, dead-letter, and backlog age', () => {
  it('retries with deterministic backoff then dead-letters', () => {
    const { queue, now } = makeQueue();
    expect(queue.enqueue(job({ jobId: 'r-1', idempotencyKey: 'r-1', maxAttempts: 2 })).kind).toBe('enqueued');
    const first = queue.fail('r-1', 'provider 429');
    expect(first.kind).toBe('retry_scheduled');
    if (first.kind !== 'retry_scheduled') throw new Error('expected retry');
    expect(first.attempt).toBe(1);
    expect(first.notBeforeMs).toBe(now.current + 1_000);
    const second = queue.fail('r-1', 'provider 429');
    expect(second).toEqual({ kind: 'dead_letter', jobId: 'r-1', reason: 'provider 429' });
    expect(queue.stats().deadLetterTotal).toBe(1);
    expect(queue.fail('r-1', 'late').kind).toBe('unknown_job');
  });

  it('tracks backlog age and flags stale backlogs', () => {
    const { queue, now } = makeQueue();
    expect(queue.enqueue(job({ jobId: 'age-1', idempotencyKey: 'age-1' })).kind).toBe('enqueued');
    expect(queue.stats().oldestAgeMs).toBe(0);
    expect(queue.stats().backlogStale).toBe(false);
    now.current += 61_000;
    expect(queue.stats().oldestAgeMs).toBe(61_000);
    expect(queue.stats().backlogStale).toBe(true);
    expect(queue.complete('age-1')).toBe(true);
    expect(queue.stats().oldestAgeMs).toBeNull();
  });

  it('reports judge depth separately so backlog cannot hide inside the total', () => {
    const { queue } = makeQueue();
    queue.enqueue(job({ jobId: 'm-1', idempotencyKey: 'm-1', kind: 'maintenance' }));
    queue.enqueue(job({ jobId: 'j-1', idempotencyKey: 'jj-1', kind: 'judge' }));
    expect(queue.stats().depth).toBe(2);
    expect(queue.stats().judgeDepth).toBe(1);
    expect(queue.pendingKind('judge')).toBe(1);
    expect(queue.pendingKind('maintenance')).toBe(1);
  });
});
