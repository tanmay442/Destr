import type { ChunkingStrategy } from '@app/domain';

export function preChunkedSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      return pages.map((p, i) => ({
        content: p.text,
        chunkIndex: i,
        page: p.page,
        sectionTitle: null,
        source: `Page ${p.page}`,
        embeddingModel: modelId,
      }));
    },
  };
}
