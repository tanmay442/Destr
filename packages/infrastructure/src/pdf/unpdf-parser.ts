import { extractText, getDocumentProxy } from 'unpdf';
import type { ContentParser } from '@app/domain';

export const unpdfParser: ContentParser = {
  async extractText(buffer: Buffer): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true });
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  },

  async extractPages(buffer: Buffer): Promise<Array<{ page: number; text: string }>> {
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true });
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: t ?? '' }));
  },
};
