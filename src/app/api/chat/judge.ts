import { after } from 'next/server';
import { logger } from '@/lib/logger';
import { judgeFaithfulness, judgeRelevance, type Composition } from '@/composition';

export function scheduleFlush(comp: Composition): void {
  try {
    after(() => {
      void comp.chatEventBatcher.flush();
    });
  } catch {
    void comp.chatEventBatcher.flush();
  }
}

interface EventMetaPatcher {
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}
interface BatcherMetaPatcher {
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
}

export function getMetaPatchers(comp: Composition): {
  eventMeta: EventMetaPatcher | null;
  batcher: BatcherMetaPatcher | null;
} {
  const candidate = comp.chatEventBatcher as unknown as Partial<EventMetaPatcher & BatcherMetaPatcher>;
  return {
    eventMeta:
      typeof candidate.updateEventMeta === 'function'
        ? { updateEventMeta: candidate.updateEventMeta.bind(candidate) }
        : null,
    batcher:
      typeof candidate.patchMeta === 'function'
        ? { patchMeta: candidate.patchMeta.bind(candidate) }
        : null,
  };
}

export async function runJudge(ctx: {
  question: string;
  snippets: string[];
  documents: string;
  answer: string;
  turnId: string;
  eventMetaPatcher: EventMetaPatcher | null;
  batcherPatcher: BatcherMetaPatcher | null;
}): Promise<void> {
  try {
    const [relevance, faithfulness] = await Promise.all([
      judgeRelevance(ctx.question, ctx.snippets),
      judgeFaithfulness(ctx.documents, ctx.answer),
    ]);
    if (!relevance && !faithfulness) return;
    const judgeScores: Record<string, unknown> = { judgedAt: new Date().toISOString() };
    if (relevance) judgeScores.retrievalRelevance = relevance.score;
    if (faithfulness) {
      judgeScores.faithfulness = faithfulness.score;
      if (faithfulness.citationPrecision !== null) judgeScores.citationPrecision = faithfulness.citationPrecision;
    }
    const patch = { judgeScores };
    const buffered = ctx.batcherPatcher ? ctx.batcherPatcher.patchMeta(ctx.turnId, patch) : false;
    if (buffered) return;
    const persisted = ctx.eventMetaPatcher
      ? await ctx.eventMetaPatcher.updateEventMeta(ctx.turnId, patch)
      : false;
    if (!persisted) {
      const retry = () =>
        void ctx.eventMetaPatcher?.updateEventMeta(ctx.turnId, patch).catch((err) => {
          logger.warn('judge.enqueue.meta_retry_failed', { turnId: ctx.turnId, error: String(err) });
        });
      const t = setTimeout(retry, 5_000);
      if (typeof t.unref === 'function') t.unref();
      logger.debug('judge.enqueue.meta_retry_scheduled', { turnId: ctx.turnId });
    }
  } catch (err) {
    logger.warn('quality judge failed', {
      severity: 'warn',
      event: 'judge.enqueue.failed',
      turnId: ctx.turnId,
      error: String(err),
    });
  }
}

export function scheduleAfter(task: () => void): void {
  try {
    after(() => task());
  } catch {
    task();
  }
}
