import { describe, it, expect } from 'vitest';
import { parentChildSplitter } from './parent-child';

const longBody =
  'This sentence is long enough to be a meaningful body of text that we can rely on for testing the parent-child strategy behaviour across multiple chunks. ' +
  'It discusses how documents are split into small child pieces for precise retrieval while a larger parent block is kept for contextual grounding. ' +
  'The agent reads the configuration at boot time and validates the schema before starting the server process that handles ingestion and search.';

const pages = [
  {
    page: 1,
    text: ['# Introduction', '', longBody, '', '## Setup', '', longBody].join('\n'),
  },
  {
    page: 2,
    text: 'This paragraph on the second page is intentionally long enough to stay separate and produce its own parent block plus several child chunks for the parent-child strategy test coverage.',
  },
];

describe('parent-child strategy', () => {
  it('emits a mix of parent and child chunks', async () => {
    const s = parentChildSplitter('test-model');
    const chunks = await s.splitPages(pages);
    expect(chunks.some((c) => c.kind === 'parent')).toBe(true);
    expect(chunks.some((c) => c.kind === 'child')).toBe(true);
  });

  it('parents have null parentChunkId and children reference a real parent', async () => {
    const s = parentChildSplitter('test-model');
    const chunks = await s.splitPages(pages);
    const parents = chunks.filter((c) => c.kind === 'parent');
    const children = chunks.filter((c) => c.kind === 'child');

    // Every parent's parentChunkId is null.
    expect(parents.every((p) => p.parentChunkId === null)).toBe(true);

    // Every child references, via parentChunkId, the global chunkIndex of a
    // parent that exists in this batch.
    const parentChunkIndexes = new Set(parents.map((p) => p.chunkIndex));
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((c) => c.parentChunkId != null && parentChunkIndexes.has(c.parentChunkId!))).toBe(true);
  });

  it('stamps model id and keeps global chunk indices unique + ordered', async () => {
    const s = parentChildSplitter('test-model');
    const chunks = await s.splitPages(pages);
    expect(chunks.every((c) => c.embeddingModel === 'test-model')).toBe(true);
    const indices = chunks.map((c) => c.chunkIndex);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual(indices.slice().sort((a, b) => a - b));
  });

  it('honours custom parent/child sizes', async () => {
    const s = parentChildSplitter('m', { parentSize: 200, childSize: 60, overlap: 10 });
    const chunks = await s.splitPages(pages);
    const parents = chunks.filter((c) => c.kind === 'parent');
    // With a tiny parent size, the input is forced into several small parents.
    expect(parents.length).toBeGreaterThan(1);
  });
});
