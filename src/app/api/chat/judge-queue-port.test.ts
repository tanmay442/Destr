import { describe, it, expect, vi } from 'vitest';
import { InfraJobSchema } from '@app/infrastructure/capacity/background-job-queue';
import type { JudgePayloadEncoded } from '@app/application/capacity/background-queue';
import {
  createJudgeQueuePort,
  type JudgePortJob,
  type JudgeQueueTarget,
} from './judge-queue-port';

/**
 * WP-8 F-39 O2: the adapter seam has direct coverage. The exact previously
 * probed failure — emitting the friendly shape (missing jobId/idempotencyKey,
 * snippets array) at the InfraJobSchema boundary — is pinned here.
 */

const JOB: JudgePortJob = {
  kind: 'judge',
  turnId: 'turn-9',
  payload: {
    question: 'How do I reset my password?',
    snippets: ['Reset it in settings.', 'Contact IT.'],
    documents: 'Reset it in settings. Contact IT.',
    answer: 'Reset it in settings.',
  },
};

function fakeTarget(
  onEnqueue?: (job: unknown) => void,
): JudgeQueueTarget & { enqueued: unknown[]; pumped: number } {
  const state = {
    enqueued: [] as unknown[],
    pumped: 0,
    async enqueue(job: {
      readonly jobId: string;
      readonly idempotencyKey: string;
      readonly kind: 'judge';
      readonly turnId: string;
      readonly payload: JudgePayloadEncoded;
    }) {
      onEnqueue?.(job);
      state.enqueued.push(job);
      return { kind: 'enqueued' as const, durable: false };
    },
    async pump() {
      state.pumped += 1;
      return { dispatched: 0, completed: 0, deadLettered: 0 };
    },
  };
  return state;
}

describe('createJudgeQueuePort', () => {
  it('emits records satisfying InfraJobSchema with an encoded payload', async () => {
    const target = fakeTarget();
    const port = createJudgeQueuePort(target, { remotePublish: false });
    const result = await port.enqueue(JOB);
    expect(result).toMatchObject({ kind: 'enqueued', durable: false });
    expect(target.enqueued).toHaveLength(1);
    const record = target.enqueued[0];
    // This parse is the exact boundary that rejected the unadapted shape.
    const parsed = InfraJobSchema.parse(record);
    expect(parsed.jobId).toContain('turn-9');
    expect(parsed.idempotencyKey).toContain('turn-9');
    expect(parsed.kind).toBe('judge');
    const payload = parsed.payload as Record<string, unknown>;
    expect(typeof payload.snippetsJson).toBe('string');
    expect(JSON.parse(payload.snippetsJson as string)).toEqual(JOB.payload.snippets);
    expect('snippets' in payload).toBe(false);
    for (const value of Object.values(payload)) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it('maps duplicate→durable from the explicit remotePublish flag (O1)', async () => {
    const queued: unknown[] = [];
    const dupTarget: JudgeQueueTarget = {
      enqueue: async (job) => {
        queued.push(job);
        return { kind: 'duplicate' };
      },
      pump: async () => ({ dispatched: 0, completed: 0, deadLettered: 0 }),
    };
    const remote = await createJudgeQueuePort(dupTarget, { remotePublish: true }).enqueue(JOB);
    expect(remote).toMatchObject({ kind: 'duplicate', durable: true });
    const local = await createJudgeQueuePort(dupTarget, { remotePublish: false }).enqueue(JOB);
    expect(local).toMatchObject({ kind: 'duplicate', durable: false });
    expect(queued).toHaveLength(2);
  });

  it('maps shed with its reason and durable false', async () => {
    const shedTarget: JudgeQueueTarget = {
      enqueue: async () => ({ kind: 'shed', reason: 'queue_full' }),
      pump: async () => ({ dispatched: 0, completed: 0, deadLettered: 0 }),
    };
    const result = await createJudgeQueuePort(shedTarget, { remotePublish: true }).enqueue(JOB);
    expect(result).toMatchObject({ kind: 'shed', reason: 'queue_full', durable: false });
  });

  it('delegates pump to the target', async () => {
    const target = fakeTarget();
    await createJudgeQueuePort(target, { remotePublish: false }).pump();
    expect(target.pumped).toBe(1);
  });

  it('rejects oversized payloads before touching the queue (O3)', async () => {
    const enqueue = vi.fn(async () => ({ kind: 'enqueued' as const, durable: false }));
    const port = createJudgeQueuePort(
      { enqueue, pump: async () => ({}) },
      { remotePublish: false },
    );
    await expect(
      port.enqueue({
        kind: 'judge',
        turnId: 'turn-9',
        payload: { ...JOB.payload, snippets: ['x'.repeat(20_001)] },
      }),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
