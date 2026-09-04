import type { InferUIMessageChunk } from 'ai';
import { logger } from '@app/domain';
import type { ChatUIMessage } from '../message-types';

type UIMessage = ChatUIMessage;

const DEFAULT_TURN_SOFT_DEADLINE_MS = 50_000;
const DEFAULT_JUDGE_MAX_WALL_MS = 20_000;

export { DEFAULT_TURN_SOFT_DEADLINE_MS, DEFAULT_JUDGE_MAX_WALL_MS };

async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>;
  result: { text: PromiseLike<string> };
  groundingDocuments: string[];
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  enabled: boolean;
  outOfDomain: boolean;
  timeoutMs?: number;
}): Promise<{ blocked: boolean; timedOut: boolean }> {
  const { controller, result, groundingDocuments, hallucinationGrader, enabled, outOfDomain } = opts;
  if (!enabled || !hallucinationGrader) return { blocked: false, timedOut: false };

  if (outOfDomain && groundingDocuments.length === 0) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: true, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
    return { blocked: true, timedOut: false };
  }

  let ungrounded = false;
  let timedOut = false;
  if (groundingDocuments.length > 0) {
    try {
      const generation = await result.text;
      const documents = groundingDocuments.join('\n\n');
      let verdict: 'yes' | 'no';
      if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0) {
        throw Object.assign(new Error('Hallucination verification skipped: no wall-time budget'), { name: 'TimeoutError' });
      } else if (opts.timeoutMs !== undefined && opts.timeoutMs < 12_000) {
        verdict = await Promise.race([
          hallucinationGrader(documents, generation),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Hallucination verification timed out'), { name: 'TimeoutError' })), opts.timeoutMs),
          ),
        ]);
      } else {
        verdict = await hallucinationGrader(documents, generation);
      }
      ungrounded = verdict === 'no';
    } catch (err) {
      const isTimeout =
        (err as { name?: string })?.name === 'TimeoutError' ||
        (err as { name?: string })?.name === 'AbortError' ||
        /timed out|budget/i.test(String((err as Error)?.message ?? ''));
      if (isTimeout) timedOut = true;
      logger.error('Hallucination check failed', { error: err });
    }
  }

  if (ungrounded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: false, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
  }
  return { blocked: ungrounded, timedOut };
}

export { runHallucinationCheck };
