import { describe } from 'vitest';
import { createLruRateLimiter } from '../../lru-rate-limiter';
import { runRateLimiterContract } from './rate-limiter-contract';

describe('lru rate limiter contract', () => {
  runRateLimiterContract(createLruRateLimiter);
});
