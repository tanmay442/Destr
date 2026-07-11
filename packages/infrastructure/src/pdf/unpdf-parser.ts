import { extractText, getDocumentProxy } from 'unpdf';
import type { PdfParser } from '@app/domain';

export const unpdfParser: PdfParser = {
  async extractText(buffer: Buffer): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true });
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  },
};
