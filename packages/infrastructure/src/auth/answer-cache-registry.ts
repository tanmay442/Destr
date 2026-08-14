import type { AnswerCache } from '@app/domain';
import { createProviderRegistry } from '../registry';

export type AnswerCacheProvider = () => AnswerCache;

export const answerCacheRegistry = createProviderRegistry<AnswerCacheProvider>();

export function registerAnswerCacheProvider(key: string, factory: AnswerCacheProvider): void {
  answerCacheRegistry.register(key, factory);
}
