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

  it('stamps every emitted chunk with the resolved model id on all strategies', async () => {
    const names = ['document-aware', 'recursive-adaptive', 'semantic', 'pre-chunked', 'parent-child'] as const;
    for (const name of names) {
      const s = getChunkingStrategy(name, { embeddings: mockEmbeddings(), modelId: 'stamp-model' });
      const chunks = await s.splitPages(pages);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.embeddingModel === 'stamp-model')).toBe(true);
    }
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

  it('preserves numbered headings instead of fragmenting them (H1)', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: '3.1. Introduction\n\nBody text that follows the numbered heading.' },
      { page: 2, text: '2.2.3 Overview\n\nMore body text.' },
    ]);
    const intro = chunks.find((c) => c.sectionTitle === '3.1. Introduction');
    const overview = chunks.find((c) => c.sectionTitle === '2.2.3 Overview');
    expect(intro).toBeDefined();
    expect(overview).toBeDefined();
    expect(intro!.source).toBe('Page 1 — 3.1. Introduction');
    expect(overview!.source).toBe('Page 2 — 2.2.3 Overview');
    expect(chunks.every((c) => c.chunkIndex === chunks.indexOf(c))).toBe(true);
  });

  it('separates a numbered heading that follows a sentence so it is detected (H1)', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: 'The results are shown below. 3.1 Methods\n\nBody.' },
    ]);
    expect(chunks.some((c) => c.sectionTitle === '3.1 Methods')).toBe(true);
    expect(chunks.some((c) => c.content.includes('shown below.'))).toBe(true);
  });

  it('splits a sentence that ends in a digit before a numbered heading (H1)', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: 'The count is 5. 3.1 Results\n\nBody.' },
    ]);
    expect(chunks.some((c) => c.sectionTitle === '3.1 Results')).toBe(true);
    expect(chunks.some((c) => c.content.includes('The count is 5.'))).toBe(true);
  });

  it('keeps the audit numbered heading intact (H1)', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: 'Section 4.2.1. Deployment\n\nBody under the section.' },
    ]);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain('Section 4.2.1. Deployment');
    expect(body).not.toContain('\n\n2.1. Deployment');
  });

  it('stamps chunks with the page their content came from, not the next page header', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: '3.1. Introduction\n\nEnd of page one body.' },
      { page: 2, text: '2.2.3 Overview\n\nPage two body.' },
    ]);
    const p1 = chunks.find((c) => c.content.includes('End of page one body'));
    const p2 = chunks.find((c) => c.content.includes('Page two body'));
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1!.page).toBe(1);
    expect(p1!.source).toBe('Page 1 — 3.1. Introduction');
    expect(p2!.page).toBe(2);
    expect(p2!.source).toBe('Page 2 — 2.2.3 Overview');
  });

  it('ignores single-token ALL-CAPS table cells mid-table', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      {
        page: 1,
        text: '## Errors\n\nName Kind\nWidget API\nGadget Web\nSome body text here describing the table shown above in full detail.',
      },
    ]);
    expect(chunks.some((c) => c.sectionTitle === 'API')).toBe(false);
    expect(chunks.some((c) => c.sectionTitle === 'Web')).toBe(false);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain('Widget');
    expect(body).toContain('Gadget');
  });

  it('keeps code-like ALL-CAPS tokens with digits or underscores as sections', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      {
        page: 4,
        text: 'source\nhost:port.\nOmniBoard\negress IPs.\nERR_1602_DATA_SOURCE_AUTH_FAILED\n\nData Source\nAuthentication\nFailed\nReset the credentials now please.',
      },
    ]);
    expect(chunks.some((c) => c.sectionTitle === 'ERR_1602_DATA_SOURCE_AUTH_FAILED')).toBe(true);
  });

  it('rejects trailing-punctuation fragments such as URL. or page numbers', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: 'Read the docs at URL.\nMore body text follows here.\n1.\n2.3.\n4.5.\n6.\nTrailing body text here.' },
    ]);
    const titles = chunks.map((c) => c.sectionTitle).filter((t) => t !== null);
    expect(titles).not.toContain('URL.');
    expect(titles.every((t) => !/^\d+\.?$/.test(t!))).toBe(true);
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

  it('keeps an intact table within a chunk when it fits', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const table = [
      '| Plan | Price |',
      '| --- | --- |',
      '| Free | $0 |',
      '| Pro | $20 |',
    ].join('\n');
    const chunks = await s.splitPages([{ page: 1, text: `## Pricing\n\n${table}` }]);
    expect(chunks.some((c) => c.content.includes('| Plan | Price |'))).toBe(true);
    expect(chunks.some((c) => c.content.includes('| Pro | $20 |'))).toBe(true);
  });

  it('keeps whitespace-column numeric tables (C7 regression)', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const table = ['Plan   Cost', '19.99  29.99', '42  17  3.1'].join('\n');
    const chunks = await s.splitPages([{ page: 1, text: `## Pricing\n\n${table}` }]);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain('19.99');
    expect(body).toContain('29.99');
    expect(body).toContain('42');
  });

  it('drops orphaned bullet artifacts but keeps surrounding content', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([{ page: 1, text: 'Intro here.\n•\n- \n1.\nKeep me.' }]);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain('Intro here.');
    expect(body).toContain('Keep me.');
  });

  it('splits an oversized table while replicating the header per chunk', async () => {
    const s = getChunkingStrategy('document-aware', {
      embeddings: mockEmbeddings(),
      maxChunkSize: 120,
      overlap: 0,
    });
    const rows = Array.from({ length: 40 }, (_, i) => `| Row ${i} | value ${i} |`);
    const table = ['| ID | Value |', '| --- | --- |', ...rows].join('\n');
    const chunks = await s.splitPages([{ page: 1, text: `## Data\n\n${table}` }]);
    const tableChunks = chunks.filter((c) => c.content.includes('| ID | Value |'));
    expect(tableChunks.length).toBeGreaterThan(1);
    expect(tableChunks.every((c) => c.content.includes('| ID | Value |'))).toBe(true);
  });

  it('never drops a small or single-line table block', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const oneLiner = '| Label | Value |';
    const singleRow = ['| Plan | Price |', '| --- | --- |', '| Free | $0 |'].join('\n');
    const chunks = await s.splitPages([
      { page: 1, text: `## Notes\n\n${oneLiner}` },
      { page: 2, text: `## Plans\n\n${singleRow}` },
    ]);
    expect(chunks.some((c) => c.content.includes('| Label | Value |'))).toBe(true);
    expect(chunks.some((c) => c.content.includes('| Free | $0 |'))).toBe(true);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
  });

  it('does not emit empty chunks', async () => {
    const s = getChunkingStrategy('document-aware', { embeddings: mockEmbeddings() });
    const chunks = await s.splitPages([
      { page: 1, text: '# Heading only\n\n\n   \n#' },
    ]);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
    expect(chunks.every((c, i) => c.chunkIndex === i)).toBe(true);
  });

  it('caps chunk sizes at the configured maxChunkSize', async () => {
    const s = getChunkingStrategy('document-aware', {
      embeddings: mockEmbeddings(),
      maxChunkSize: 200,
      overlap: 20,
    });
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph number ${i + 1} with some words.`).join(
      '\n\n',
    );
    const chunks = await s.splitPages([{ page: 1, text: long }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 200 + 20)).toBe(true);
  });
});

describe('degenerate inputs', () => {
  const strategies: Array<'document-aware' | 'recursive-adaptive' | 'semantic' | 'parent-child' | 'pre-chunked'> = [
    'document-aware',
    'recursive-adaptive',
    'semantic',
    'parent-child',
    'pre-chunked',
  ];

  it('handles empty, single-char and all-whitespace pages without crashing', async () => {
    for (const name of strategies.filter((n) => n !== 'pre-chunked')) {
      const s = getChunkingStrategy(name, { embeddings: mockEmbeddings() });
      await expect(s.splitPages([])).resolves.toEqual([]);
      await expect(s.splitPages([{ page: 1, text: '' }])).resolves.toEqual([]);
      await expect(s.splitPages([{ page: 1, text: '   \n  \n' }])).resolves.toEqual([]);
      const one = await s.splitPages([{ page: 1, text: 'x' }]);
      expect(one.every((c) => c.content.trim().length > 0)).toBe(true);
    }
    const pre = getChunkingStrategy('pre-chunked', { embeddings: mockEmbeddings() });
    expect(await pre.splitPages([{ page: 1, text: '' }])).toHaveLength(1);
    expect((await pre.splitPages([{ page: 1, text: 'x' }]))[0]!.content).toBe('x');
  });

  it('keeps a single overlong sentence as one chunk (never drops it)', async () => {
    for (const name of strategies) {
      const s = getChunkingStrategy(name, { embeddings: mockEmbeddings() });
      const long = 'word '.repeat(1200).trim();
      const chunks = await s.splitPages([{ page: 1, text: long }]);
      expect(chunks.length).toBeGreaterThan(0);
      const body = chunks.map((c) => c.content).join('\n');
      expect(body).toContain('word');
    }
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

  it('splits at the per-document topic shift instead of a fixed threshold', async () => {
    const topical = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockImplementation(async (values: string[]) =>
        values.map((v) => (v.toLowerCase().includes('quantum') ? [0, 1, 0, 0] : [1, 0, 0, 0])),
      ),
    };
    const s = getChunkingStrategy('semantic', { embeddings: topical });
    const text =
      'Cats are small pets. Cats like warm laps. Quantum entanglement links particles. Quantum states collapse on measurement.';
    const chunks = await s.splitPages([{ page: 1, text }]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain('Cats');
    expect(body).toContain('Quantum');
  });

  it('keeps near-uniform text coherent instead of over-splitting', async () => {
    const flat = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue([
        [1, 0, 0, 0],
        [1, 0, 0, 0],
        [1, 0, 0, 0],
        [1, 0, 0, 0],
      ]),
    };
    const s = getChunkingStrategy('semantic', { embeddings: flat });
    const chunks = await s.splitPages([
      { page: 1, text: 'The cat sat. The cat slept. The cat ate. The cat purred.' },
    ]);
    expect(chunks).toHaveLength(1);
  });

  it('throws when the embedding service returns fewer vectors than sentences', async () => {
    const shortEmbeddings = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue([]),
    };
    const s = getChunkingStrategy('semantic', { embeddings: shortEmbeddings });
    await expect(s.splitPages(pages)).rejects.toThrow(/embedding count mismatch/);
  });

  it('falls back to recursive-adaptive beyond the sentence cap (C9)', async () => {
    const embeddings = mockEmbeddings();
    const embedBatch = vi.spyOn(embeddings, 'embedBatch');
    const s = getChunkingStrategy('semantic', { embeddings });
    const huge = 'Hello world. '.repeat(2100);
    const chunks = await s.splitPages([{ page: 1, text: huge }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('falls back to recursive-adaptive when embedding fails (C9)', async () => {
    const failing = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockRejectedValue(new Error('embed API down')),
    };
    const s = getChunkingStrategy('semantic', { embeddings: failing });
    const chunks = await s.splitPages(pages);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('embeds in bounded batches rather than one giant call (C9)', async () => {
    const embeddings = mockEmbeddings();
    const embedBatch = vi.spyOn(embeddings, 'embedBatch');
    const s = getChunkingStrategy('semantic', { embeddings });
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} here.`).join(' ');
    await s.splitPages([{ page: 1, text }]);
    expect(embedBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of embedBatch.mock.calls) {
      expect((call[0] as string[]).length).toBeLessThanOrEqual(50);
    }
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
