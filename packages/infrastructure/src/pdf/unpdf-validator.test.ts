import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParseError } from '@app/domain';
import { unpdfValidator } from './unpdf-validator';

describe('unpdfValidator', () => {
  it('accepts a structurally valid PDF', async () => {
    const pdf = await readFile(resolve(process.cwd(), 'scripts/fixtures/sample.pdf'));
    await expect(unpdfValidator.validate(pdf)).resolves.toBeUndefined();
  });

  it('rejects a PDF signature followed by garbage', async () => {
    await expect(unpdfValidator.validate(new TextEncoder().encode('%PDF-garbage')))
      .rejects.toBeInstanceOf(ParseError);
  });

  it('does not start parsing when validation is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const pdf = await readFile(resolve(process.cwd(), 'scripts/fixtures/sample.pdf'));
    await expect(unpdfValidator.validate(pdf, { signal: controller.signal }))
      .rejects.toThrow('timed out');
  });
});
