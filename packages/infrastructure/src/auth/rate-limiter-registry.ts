import type { RateLimiter } from '@app/domain';
import { createProviderRegistry } from '../registry';

export type RateLimiterProvider = () => RateLimiter;

export const rateLimiterRegistry = createProviderRegistry<RateLimiterProvider>();

export function registerRateLimiterProvider(key: string, factory: RateLimiterProvider): void {
  rateLimiterRegistry.register(key, factory);
}