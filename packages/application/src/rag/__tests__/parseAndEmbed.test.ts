import { describe, it, expect, vi } from 'vitest';
import { parseAndEmbed } from '../ingest';
import type { ParseDeps } from '../ingest';
import type { DocSummarizer } from '@app/domain';

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
});
