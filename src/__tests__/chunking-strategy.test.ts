import { describe, it, expect } from 'vitest';
import { appConfig } from '@/lib/config';
import { Chunking } from '@app/infrastructure';

describe('chunking strategy wiring (Session 4)', () => {
  it('resolves document-aware as the default ingest strategy', () => {
    expect(appConfig.chunkingStrategy).toBe('document-aware');
  });

  it('the resolved default strategy exposes a splitPages implementation', () => {
    const strategy = Chunking.getChunkingStrategy(appConfig.chunkingStrategy, {
      embeddings: { embed: async () => [], embedBatch: async () => [] },
    });
    expect(typeof strategy.splitPages).toBe('function');
  });
});
