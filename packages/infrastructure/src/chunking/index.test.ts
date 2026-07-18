import { describe, it, expect, vi } from 'vitest';
import { getChunkingStrategy } from './index';
import type { EmbeddingService } from '@app/domain';

function mockEmbeddings(): EmbeddingService {
  return {
    embed: vi.fn(),
    embedBatch: vi.fn().mockImplementation(async (values: string[]) =>
      values.map((v) => Array.from({ length: 4 }, (_, i) => Math.sin(v.length + i))),
    ),
  };
}

const pages = [
  {
    page: 1,
    text: [
      '# Introduction',
      '',
      'The system ingests documents. It splits them into chunks. This sentence is long enough to be a real body of text that we can rely on for testing the strategy behaviour.',
      '',
      '## Setup',
      '',
      'Configuration lives in a config file. The agent reads it at boot time and validates the schema before starting the server process.',
    ].join('\n'),
  },
  {
    page: 2,
    text: 'This paragraph on the second page is intentionally long enough to stay separate from the first page content rather than being merged into it by the adaptive strategy. It discusses operational details such as monitoring, alerting, and how the ingest queue retries failed documents automatically without operator intervention.',
  },
];

describe('getChunkingStrategy registry', () => {
  it('resolves document-aware by name', () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    expect(typeof s.splitPages).toBe('function');
  });

  it('resolves recursive-adaptive, semantic, pre-chunked', () => {
    expect(typeof getChunkingStrategy('recursive-adaptive', { embeddings: mockEmbeddings() }).splitPages).toBe('function');
    expect(typeof getChunkingStrategy('semantic', { embeddings: mockEmbeddings() }).splitPages).toBe('function');
    expect(typeof getChunkingStrategy('pre-chunked', { embeddings: mockEmbeddings() }).splitPages).toBe('function');
  });

  it('throws on an unknown strategy name', () => {
    // @ts-expect-error exercising the exhaustive default branch
    expect(() => getChunkingStrategy('bogus', { embeddings: mockEmbeddings() })).toThrow(/Unknown chunking strategy/);
  });

  it('passes the resolved model id into chunks', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings(), modelId: 'test-model' });
    const chunks = await s.splitPages(pages);
    expect(chunks.every((c) => c.embeddingModel === 'test-model')).toBe(true);
  });
});

describe('document-aware strategy', () => {
  it('detects headings and sets sectionTitle + page + source', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages(pages);
    expect(chunks.length).toBeGreaterThan(0);
    const intro = chunks.find((c) => c.sectionTitle === 'Introduction');
    const setup = chunks.find((c) => c.sectionTitle === 'Setup');
    expect(intro).toBeDefined();
    expect(setup).toBeDefined();
    expect(intro!.page).toBe(1);
    expect(intro!.source).toBe('Page 1 — Introduction');
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks.every((c, i) => c.chunkIndex === i)).toBe(true);
  });

  it('stamps a title from ALL-CAPS headings', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      {
        page: 3,
        text: 'OVERVIEW\n\nThis section describes the overview of the product in a sentence that is sufficiently long to be kept as a single chunk body.',
      },
    ]);
    expect(chunks.some((c) => c.sectionTitle === 'OVERVIEW')).toBe(true);
  });
});

describe('recursive-adaptive strategy', () => {
  it('splits on paragraph boundaries and maps pages', async () => {
    const s = getChunkingStrategy('recursive-adaptive', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages(pages);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.sectionTitle === null)).toBe(true);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks.every((c, i) => c.chunkIndex === i)).toBe(true);
    expect(chunks.some((c) => c.page === 2)).toBe(true);
  });

  it('keeps correct page mapping past runs of 3+ blank lines', async () => {
    const s = getChunkingStrategy('recursive-adaptive', { embeddings: mockEmbeddings() });
    const long =
      'This paragraph is deliberately long enough to stay separate from the merge threshold and represents page one content that should be mapped to page one by the offset logic after several blank lines separate the next paragraph.';
    const chunks = await s.splitPages([
      { page: 1, text: long },
      { page: 2, text: '\n\n\n\n' + long },
    ]);
    const p2 = chunks.find((c) => c.page === 2);
    expect(p2).toBeDefined();
    expect(p2!.content).toContain('page one content');
  });
});

describe('semantic strategy', () => {
  it('produces variable-sized chunks driven by embedding similarity', async () => {
    const s = getChunkingStrategy('semantic', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages(pages);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.sectionTitle === null)).toBe(true);
    const lengths = chunks.map((c) => c.content.length);
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });

  it('throws when the embedding service returns fewer vectors than sentences', async () => {
    const shortEmbeddings = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue([]),
    };
    const s = getChunkingStrategy('semantic', { embeddings: shortEmbeddings });
    await expect(s.splitPages(pages)).rejects.toThrow(/embedding count mismatch/);
  });
});

describe('pre-chunked strategy', () => {
  it('passes each page through as one chunk preserving page', async () => {
    const s = getChunkingStrategy('pre-chunked', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages(pages);
    expect(chunks).toHaveLength(pages.length);
    expect(chunks[0]!.page).toBe(1);
    expect(chunks[1]!.page).toBe(2);
    expect(chunks[0]!.source).toBe('Page 1');
  });
});
