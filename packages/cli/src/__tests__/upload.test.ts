import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runUpload } from '../commands/upload';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'upload-test-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

function writeMarkdown(name = 'source.md'): string {
  const path = join(work, name);
  writeFileSync(path, '---chunk---\nA chunk\n');
  return path;
}

describe('runUpload file handling', () => {
  it('reports a contextual error for a missing Markdown file without a stack trace', async () => {
    const path = join(work, 'missing.md');
    await expect(runUpload({ md: 'missing.md', fixturesDir: work, upload: vi.fn() })).rejects.toThrow(
      new RegExp(`Markdown file could not be read: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('reports a contextual error when the Markdown path is not a regular file', async () => {
    mkdirSync(join(work, 'folder'));
    const path = join(work, 'folder');
    await expect(runUpload({ md: 'folder', fixturesDir: work, upload: vi.fn() })).rejects.toThrow(
      `Markdown file path is not a file: ${path}`,
    );
  });

  it('checks the descriptor size before reading and includes the path on overflow', async () => {
    const path = writeMarkdown();
    vi.stubEnv('UPLOAD_CHUNKED_MAX_MD_BYTES', '2');
    await expect(runUpload({ md: 'source.md', fixturesDir: work, upload: vi.fn() })).rejects.toThrow(
      `Markdown file exceeds maximum size of 2 bytes: ${path}`,
    );
  });

  it('reports missing and malformed companion files with their paths', async () => {
    writeMarkdown();
    const missing = join(work, 'missing.pdf');
    await expect(runUpload({ md: 'source.md', pdf: 'missing.pdf', fixturesDir: work, upload: vi.fn() })).rejects.toThrow(
      new RegExp(`PDF companion file could not be read: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );

    const malformed = join(work, 'bad.pdf');
    writeFileSync(malformed, 'not a PDF');
    await expect(runUpload({ md: 'source.md', pdf: 'bad.pdf', fixturesDir: work, upload: vi.fn() })).rejects.toThrow(
      `PDF companion is not a valid PDF: ${malformed}`,
    );
  });

  it('reads Markdown and a companion PDF from stable descriptors and passes both to upload', async () => {
    writeMarkdown();
    const pdf = Buffer.from('%PDF-1.7\nfixture');
    writeFileSync(join(work, 'source.pdf'), pdf);
    const upload = vi.fn().mockResolvedValue({ documentId: 1, chunks: 1, status: 'inserted' as const });

    await runUpload({ md: 'source.md', pdf: 'source.pdf', fixturesDir: work, upload });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'source.md',
      mdText: '---chunk---\nA chunk\n',
      pdfBuffer: pdf,
    }));
  });
});
