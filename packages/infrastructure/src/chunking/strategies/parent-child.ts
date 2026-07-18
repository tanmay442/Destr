import type { ChunkingStrategy } from '@app/domain';
import {
  chunkBySentences,
  buildSections,
  mergeShortSections,
  makeDocumentChunk,
  CHILD_TOKEN_CAP,
  type Section,
} from '../shared';

const DEFAULT_PARENT_SIZE = 1800;
const DEFAULT_CHILD_SIZE = 400;
const DEFAULT_OVERLAP = 80;
const SECTION_MERGE_MAX = 80;

export interface ParentChildOptions {
  /** Max size of a parent block (chars). Default 1800. */
  parentSize?: number;
  /** Max size of a child chunk (chars). Default 400. */
  childSize?: number;
  /** Overlap carried between consecutive children (chars). Default 80. */
  overlap?: number;
}

/**
 * Parent-child chunking (Session 5).
 *
 * Each page is split into sections, sections are grouped into ~`parentSize`
 * parent blocks, and every parent block is split into small `child` chunks
 * (sentence-boundary, ~`childSize`). Children are embedded for precise
 * retrieval; the larger parent block is returned for context (resolved by
 * `searchChunks`).
 *
 * Children reference their parent via `parentChunkId`, which is set to the
 * parent's *global* `chunkIndex` at strategy time (a stable in-batch key).
 * `insertChunks` resolves that key to the real surrogate id during the
 * two-pass insert (parents first, then children). Parents themselves have
 * `parentChunkId = null` and `kind = 'parent'`.
 */
export function parentChildSplitter(modelId: string, opts: ParentChildOptions = {}): ChunkingStrategy {
  const parentSize = opts.parentSize ?? DEFAULT_PARENT_SIZE;
  const childSize = opts.childSize ?? DEFAULT_CHILD_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  /** Greedily group consecutive sections of one page into parent blocks. */
  function groupIntoParents(sections: Section[]): Section[] {
    const parents: Section[] = [];
    let current: Section | null = null;
    for (const s of sections) {
      const candidate = current
        ? (current.text + '\n\n' + (s.title ? s.title + '\n' : '') + s.text).trim()
        : s.text;
      if (current && candidate.length <= parentSize) {
        current.text = candidate;
        // Keep the first section's title as the parent's title.
      } else {
        if (current) parents.push(current);
        current = { title: s.title, text: s.text };
      }
    }
    if (current) parents.push(current);
    return parents;
  }

  return {
    async splitPages(pages) {
      const chunks = [];
      let chunkIndex = 0;
      for (const { page, text } of pages) {
        let sections = buildSections(text);
        sections = mergeShortSections(sections, SECTION_MERGE_MAX);
        const parents = groupIntoParents(sections);
        for (const parent of parents) {
          if (parent.text.trim().length === 0) continue;
          const parentIndex = chunkIndex++;
          const parentTitle = parent.title;
          const parentSource = parentTitle ? `Page ${page} — ${parentTitle}` : `Page ${page}`;
          // Emit the parent block (returned for context, not used for retrieval
          // filtering — `searchByVector` excludes `kind = 'parent'`).
          chunks.push(
            makeDocumentChunk({
              content: parent.text,
              chunkIndex: parentIndex,
              page,
              modelId,
              sectionTitle: parentTitle,
              source: parentSource,
              parentChunkId: null,
              kind: 'parent',
            }),
          );
          const children =
            parent.text.length > childSize
              ? chunkBySentences(parent.text, childSize, overlap, modelId, CHILD_TOKEN_CAP)
              : [parent.text];
          for (const child of children) {
            const childSource = parentTitle ? `Page ${page} — ${parentTitle}` : `Page ${page}`;
            chunks.push(
              makeDocumentChunk({
                content: child,
                chunkIndex: chunkIndex++,
                page,
                modelId,
                sectionTitle: parentTitle,
                source: childSource,
                parentChunkId: parentIndex,
                kind: 'child',
              }),
            );
          }
        }
      }
      return chunks;
    },
  };
}
