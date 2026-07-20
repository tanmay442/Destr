import { extractText, getDocumentProxy } from 'unpdf';
import { ParseError, PDF_PARSE_MAX_BYTES, PDF_PARSE_MAX_PAGES, PDF_PARSE_MAX_CHARS } from '@app/domain';
import type { ContentParser } from '@app/domain';

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

function toParseError(cause: unknown): ParseError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ParseError(`Failed to parse PDF: ${msg}`, cause);
}

/** Re-join spaces unpdf inserts inside dotted tokens (versions, URLs, emails). */
function repairPdfSpacing(text: string): string {
  let out = text;

  // Join "x. y" only when the char after the space is lowercase/digit, so real
  // sentence boundaries like "Inc. OmniBoard" are preserved.
  out = out.replace(/([A-Za-z0-9])\.\s+([a-z0-9])/g, '$1.$2');
  out = out.replace(/([A-Za-z0-9])-\s+([A-Za-z0-9])/g, '$1-$2');

  return out;
}

export const unpdfParser: ContentParser = {
  async extractText(buffer: Buffer): Promise<string> {
    if (buffer.length > PDF_PARSE_MAX_BYTES) {
      throw new ParseError(`PDF is ${buffer.length} bytes (> ${PDF_PARSE_MAX_BYTES})`);
    }
    let pdf: PdfProxy | undefined;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true });
      if (pdf.numPages > PDF_PARSE_MAX_PAGES) {
        throw new ParseError(`PDF has ${pdf.numPages} pages (> ${PDF_PARSE_MAX_PAGES})`);
      }
      const { text } = await extractText(pdf, { mergePages: true });
      if (text.length > PDF_PARSE_MAX_CHARS) {
        throw new ParseError(`PDF extracted text is ${text.length} chars (> ${PDF_PARSE_MAX_CHARS})`);
      }
      return repairPdfSpacing(text);
    } catch (cause) {
      if (cause instanceof ParseError) throw cause;
      throw toParseError(cause);
    } finally {
      await pdf?.destroy();
    }
  },

  async extractPages(buffer: Buffer): Promise<Array<{ page: number; text: string }>> {
    if (buffer.length > PDF_PARSE_MAX_BYTES) {
      throw new ParseError(`PDF is ${buffer.length} bytes (> ${PDF_PARSE_MAX_BYTES})`);
    }
    let pdf: PdfProxy | undefined;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: true });
      if (pdf.numPages > PDF_PARSE_MAX_PAGES) {
        throw new ParseError(`PDF has ${pdf.numPages} pages (> ${PDF_PARSE_MAX_PAGES})`);
      }
      const { text } = await extractText(pdf, { mergePages: false });
      return text
        .slice(0, PDF_PARSE_MAX_PAGES)
        .map((t, i) => ({ page: i + 1, text: repairPdfSpacing(t ?? '').slice(0, PDF_PARSE_MAX_CHARS) }));
    } catch (cause) {
      if (cause instanceof ParseError) throw cause;
      throw toParseError(cause);
    } finally {
      await pdf?.destroy();
    }
  },
};
