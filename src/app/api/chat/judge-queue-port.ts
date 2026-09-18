import {
  encodeJudgePayload,
  judgeIdempotencyKey,
  judgeJobId,
  type JudgePayloadEncoded,
  type JudgePayloadInput,
} from '@app/application/capacity/background-queue';

/**
 * Route-layer adapter for the durable background queue (WP-8 F-39).
 *
 * Lives here (not in composition) so it stays importable by route-layer
 * tests: composition.ts cannot be imported outside the server runtime, but
 * this module depends only on the provider-neutral application codec.
 * The queue itself is structural on purpose — route code must not import
 * infrastructure queue types (architecture rule); the composition-provided
 * durable queue satisfies this shape.
 */
export interface JudgePortJob {
  readonly kind: 'judge';
  readonly turnId: string;
  readonly payload: JudgePayloadInput;
}

export type JudgePortResult =
  | { readonly kind: 'enqueued'; readonly durable: boolean }
  | { readonly kind: 'duplicate'; readonly durable: boolean }
  | { readonly kind: 'shed'; readonly reason: string; readonly durable: false };

export interface JudgeQueueTarget {
  enqueue(job: {
    readonly jobId: string;
    readonly idempotencyKey: string;
    readonly kind: 'judge';
    readonly turnId: string;
    readonly payload: JudgePayloadEncoded;
  }): Promise<
    | { readonly kind: 'enqueued'; readonly durable: boolean }
    | { readonly kind: 'duplicate' }
    | { readonly kind: 'shed'; readonly reason: string }
  >;
  pump(): Promise<unknown>;
}

export interface JudgeQueuePort {
  enqueue(job: JudgePortJob): Promise<JudgePortResult>;
  pump(): Promise<unknown>;
}

/**
 * Map one judge job onto the infrastructure record shape. `remotePublish`
 * must reflect whether the target publishes remotely: a duplicate in remote
 * mode refers to the remotely-delivered original (durable, needs no pump);
 * in buffer mode the pending original still needs its pump (not durable).
 */
export function createJudgeQueuePort(
  queue: JudgeQueueTarget,
  opts: { readonly remotePublish: boolean },
): JudgeQueuePort {
  return {
    enqueue: async (job) => {
      const result = await queue.enqueue({
        jobId: judgeJobId(job.turnId),
        idempotencyKey: judgeIdempotencyKey(job.turnId),
        kind: 'judge',
        turnId: job.turnId,
        payload: encodeJudgePayload(job.payload),
      });
      if (result.kind === 'enqueued') return { kind: 'enqueued', durable: result.durable };
      if (result.kind === 'duplicate') {
        return { kind: 'duplicate', durable: opts.remotePublish };
      }
      return { kind: 'shed', reason: result.reason, durable: false };
    },
    pump: () => queue.pump(),
  };
}
