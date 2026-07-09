// pdf-parse adapter. Importing `lib/pdf-parse.js` directly bypasses the
// library's debug branch that crashes Turbopack builds by reading a test PDF.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { PdfParser } from '@app/domain';

export const pdfParseParser: PdfParser = {
  async extractText(buffer: Buffer): Promise<string> {
    const result = await pdfParse(buffer);
    return result.text;
  },
};
