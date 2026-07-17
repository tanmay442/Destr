import type { ChunkingStrategy } from '@app/domain';
import { makeDocumentChunk } from '../shared';

/**
 * Pre-chunked splitter.
 *
 * The ingest pipeline never feeds pre-parsed markdown into this strategy — it
 * always passes already-split pages. Each input page therefore becomes exactly
 * one chunk (its `sectionTitle` is left null and `source` records the page).
 * `MarkdownParser.parseChunkedMarkdown` exists for callers that want richer
 * pre-chunked markdown metadata, but this strategy intentionally keeps the
 * 1-page→1-chunk contract so positional chunk indices stay stable for the
 * parent-child self-FK resolution in `insertChunks`.
 */
export function preChunkedSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      return pages.map((p, i) =>
        makeDocumentChunk({
          content: p.text,
          chunkIndex: i,
          page: p.page,
          modelId,
        }),
      );
    },
  };
}
