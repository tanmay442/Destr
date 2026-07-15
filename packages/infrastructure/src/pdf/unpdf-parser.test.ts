import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unpdfParser } from './unpdf-parser';
import type { ContentParser } from '@app/domain';

const samplePdf = readFileSync(resolve(__dirname, '../../../../scripts/fixtures/sample.pdf'));

describe('unpdfParser', () => {
  it('implements ContentParser (extractText + extractPages)', () => {
    const parser: ContentParser = unpdfParser;
    expect(typeof parser.extractText).toBe('function');
    expect(typeof parser.extractPages).toBe('function');
  });

  it('extractText returns merged document text', async () => {
    const text = await unpdfParser.extractText(samplePdf);
    expect(text).toContain('Gardenia Public School');
  });

  it('extractPages returns per-page text (not merged)', async () => {
    const pages = await unpdfParser.extractPages(samplePdf);
    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]!.page).toBe(1);
    expect(pages[0]!.text).toContain('Gardenia Public School');
    expect(pages[0]!.text).not.toContain('\n\n\n\n');
  });
});
