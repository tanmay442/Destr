import { describe, it, expect, vi } from 'vitest';
import { parseAndEmbed } from '../ingest';
import type { ParseDeps } from '../ingest';
import type { ChunkingStrategy, ContentParser, DocSummarizer } from '@app/domain';

function makeParseDeps(overrides?: Partial<ParseDeps>): ParseDeps {
  return {
    embeddings: {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]),
    },
    pdfParser: { extractText: vi.fn().mockResolvedValue('Alpha text. Beta text.') },
    textSplitter: { splitText: vi.fn().mockResolvedValue(['Alpha text.', 'Beta text.']) },
    ...overrides,
  };
}

describe('parseAndEmbed (Contextual Chunk Headers)', () => {
  it('embeds header+content but keeps stored content clean when a summarizer is wired', async () => {
    const summarizer: DocSummarizer = {
      generateDocContext: vi.fn().mockResolvedValue({ title: 'My Doc', summary: 'About things.' }),
    };
    const deps = makeParseDeps({ summarizer });

    const result = await parseAndEmbed(
      { fileName: 'd.pdf', buffer: Buffer.from('x') },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith([
      'Document: My Doc\nSummary: About things.\n\nAlpha text.',
      'Document: My Doc\nSummary: About things.\n\nBeta text.',
    ]);
    expect(result.value.rows).toEqual([
      expect.objectContaining({
        content: 'Alpha text.',
        title: 'My Doc',
        chunkIndex: 0,
      }),
      expect.objectContaining({
        content: 'Beta text.',
        title: 'My Doc',
        chunkIndex: 1,
      }),
    ]);
  });

  it('does not prepend any header when no summarizer is supplied', async () => {
    const deps = makeParseDeps();

    const result = await parseAndEmbed(
      { fileName: 'd.pdf', buffer: Buffer.from('x') },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(['Alpha text.', 'Beta text.']);
    for (const row of result.value.rows) {
      expect(row.content.startsWith('Document:')).toBe(false);
      expect(row.title).toBeNull();
    }
  });

  it('skips the header when CCH_ENABLED=false even if a summarizer exists', async () => {
    const summarizer: DocSummarizer = {
      generateDocContext: vi.fn().mockResolvedValue({ title: 'My Doc', summary: 'About things.' }),
    };
    const deps = makeParseDeps({ summarizer, cchEnabled: false });

    const result = await parseAndEmbed(
      { fileName: 'd.pdf', buffer: Buffer.from('x') },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizer.generateDocContext).not.toHaveBeenCalled();
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(['Alpha text.', 'Beta text.']);
    expect(result.value.rows[0]!.title).toBeNull();
  });

  it('stamps title metadata even when the summarizer returns only a summary (no header)', async () => {
    const summarizer: DocSummarizer = {
      generateDocContext: vi.fn().mockResolvedValue({ title: '', summary: 'loose summary' }),
    };
    const deps = makeParseDeps({ summarizer });

    const result = await parseAndEmbed(
      { fileName: 'd.pdf', buffer: Buffer.from('x') },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0]!.content).toBe('Alpha text.');
    expect(result.value.rows[0]!.title).toBeNull();
  });

  it('stores a zero-vector placeholder for parent blocks and skips their embedding call', async () => {
    const contentParser: ContentParser = {
      extractPages: vi.fn().mockResolvedValue([{ page: 1, text: 'Parent block body. Child one. Child two.' }]),
      extractText: vi.fn(),
    };
    const chunkingStrategy: ChunkingStrategy = {
      splitPages: vi.fn().mockResolvedValue([
        { content: 'Parent block body.', chunkIndex: 0, page: 1, parentChunkId: null, kind: 'parent' },
        { content: 'Child one.', chunkIndex: 1, page: 1, parentChunkId: 0, kind: 'child' },
        { content: 'Child two.', chunkIndex: 2, page: 1, parentChunkId: 0, kind: 'child' },
      ]),
    };
    const deps = makeParseDeps({ contentParser, chunkingStrategy });
    deps.embeddings.embedBatch = vi
      .fn()
      .mockImplementation(async (texts: string[]) => texts.map((_, i) => [i + 1, 0, 0]));

    const result = await parseAndEmbed({ fileName: 'd.pdf', buffer: Buffer.from('x') }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(['Child one.', 'Child two.']);
    const [parent, child1, child2] = result.value.rows;
    expect(parent!.kind).toBe('parent');
    expect(parent!.embedding).toEqual([0, 0, 0]);
    expect(child1!.embedding).toEqual([1, 0, 0]);
    expect(child2!.embedding).toEqual([2, 0, 0]);
  });

  it('embeds the CCH header via the strategy path but stores clean content, carrying sectionTitle + source', async () => {
    const summarizer: DocSummarizer = {
      generateDocContext: vi.fn().mockResolvedValue({ title: 'My Doc', summary: 'About things.' }),
    };
    const contentParser: ContentParser = {
      extractPages: vi.fn().mockResolvedValue([{ page: 1, text: 'doc' }]),
      extractText: vi.fn(),
    };
    const chunkingStrategy: ChunkingStrategy = {
      splitPages: vi.fn().mockResolvedValue([
        { content: 'Section A body.', chunkIndex: 0, page: 1, sectionTitle: 'Section A', source: 'Page 1 — Section A' },
        { content: 'Section B body.', chunkIndex: 1, page: 1, sectionTitle: 'Section B', source: 'Page 1 — Section B' },
      ]),
    };
    const deps = makeParseDeps({ summarizer, contentParser, chunkingStrategy });

    const result = await parseAndEmbed({ fileName: 'd.pdf', buffer: Buffer.from('x') }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith([
      'Document: My Doc\nSummary: About things.\n\nSection A body.',
      'Document: My Doc\nSummary: About things.\n\nSection B body.',
    ]);
    expect(result.value.rows).toEqual([
      expect.objectContaining({
        content: 'Section A body.',
        sectionTitle: 'Section A',
        source: 'Page 1 — Section A',
        title: 'My Doc',
      }),
      expect.objectContaining({
        content: 'Section B body.',
        sectionTitle: 'Section B',
        source: 'Page 1 — Section B',
        title: 'My Doc',
      }),
    ]);
  });
});
