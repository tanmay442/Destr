import { describe } from 'vitest';
import { createInMemoryAnswerCache } from '../../in-memory-answer-cache';
import { runAnswerCacheContract } from './answer-cache-contract';

describe('in-memory answer cache contract', () => {
  runAnswerCacheContract(createInMemoryAnswerCache);
});
