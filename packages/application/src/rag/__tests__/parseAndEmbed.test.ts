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
  it('prepends the header to every chunk and embeds header+content when a summarizer is wired', async () => {
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
        content: 'Document: My Doc\nSummary: About things.\n\nAlpha text.',
        title: 'My Doc',
        summary: 'About things.',
        chunkIndex: 0,
      }),
      expect.objectContaining({
        content: 'Document: My Doc\nSummary: About things.\n\nBeta text.',
        title: 'My Doc',
        summary: 'About things.',
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
      expect(row.summary).toBeNull();
    }
  });

  it('skips the header when CCH_ENABLED=false even if a summarizer exists', async () => {
    // CCH_ENABLED is a frozen const read at module load, so re-import the module
    // with the env set first to exercise the disabled path.
    vi.stubEnv('CCH_ENABLED', 'false');
    vi.resetModules();
    const { parseAndEmbed: parseAndEmbedFresh } = await import('../ingest');

    const summarizer: DocSummarizer = {
      generateDocContext: vi.fn().mockResolvedValue({ title: 'My Doc', summary: 'About things.' }),
    };
    const deps = makeParseDeps({ summarizer });

    const result = await parseAndEmbedFresh(
      { fileName: 'd.pdf', buffer: Buffer.from('x') },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizer.generateDocContext).not.toHaveBeenCalled();
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(['Alpha text.', 'Beta text.']);
    expect(result.value.rows[0]!.title).toBeNull();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('stamps metadata even when the summarizer returns only a summary (no header)', async () => {
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
    // No title → no header prepended, but metadata is recorded.
    expect(result.value.rows[0]!.content).toBe('Alpha text.');
    expect(result.value.rows[0]!.title).toBeNull();
    expect(result.value.rows[0]!.summary).toBe('loose summary');
  });

  it('stores a zero-vector placeholder for parent blocks and skips their embedding call (S5 Option C)', async () => {
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
    // One embedding per embeddable chunk (children only), length 3.
    deps.embeddings.embedBatch = vi
      .fn()
      .mockImplementation(async (texts: string[]) => texts.map((_, i) => [i + 1, 0, 0]));

    const result = await parseAndEmbed({ fileName: 'd.pdf', buffer: Buffer.from('x') }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Parent content must NOT be sent to the embedding API (only the 2 children).
    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(['Child one.', 'Child two.']);
    const [parent, child1, child2] = result.value.rows;
    expect(parent!.kind).toBe('parent');
    expect(parent!.embedding).toEqual([0, 0, 0]);
    expect(child1!.embedding).toEqual([1, 0, 0]);
    expect(child2!.embedding).toEqual([2, 0, 0]);
  });

  it('composes the CCH header with the strategy path, carrying sectionTitle + source', async () => {
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
        content: 'Document: My Doc\nSummary: About things.\n\nSection A body.',
        sectionTitle: 'Section A',
        source: 'Page 1 — Section A',
        title: 'My Doc',
      }),
      expect.objectContaining({
        content: 'Document: My Doc\nSummary: About things.\n\nSection B body.',
        sectionTitle: 'Section B',
        source: 'Page 1 — Section B',
        title: 'My Doc',
      }),
    ]);
  });
});

