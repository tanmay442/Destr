import { getDocumentProxy } from 'unpdf';
import { ParseError, PDF_PARSE_MAX_BYTES, PDF_PARSE_MAX_PAGES, PDF_PARSE_MAX_CHARS } from '@app/domain';
import type { ContentParser } from '@app/domain';

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

function toParseError(cause: unknown): ParseError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ParseError(`Failed to parse PDF: ${msg}`, cause);
}

/** Open a PDF proxy, enforcing the byte and page-count guards up front. The
 *  input is viewed zero-copy (never copied, never detached by the parser). */
async function openPdf(buffer: Buffer): Promise<PdfProxy> {
  if (buffer.length > PDF_PARSE_MAX_BYTES) {
    throw new ParseError(`PDF is ${buffer.length} bytes (> ${PDF_PARSE_MAX_BYTES})`);
  }
  try {
    const pdf = await getDocumentProxy(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      { useSystemFonts: true },
    );
    if (pdf.numPages > PDF_PARSE_MAX_PAGES) {
      await pdf.destroy();
      throw new ParseError(`PDF has ${pdf.numPages} pages (> ${PDF_PARSE_MAX_PAGES})`);
    }
    return pdf;
  } catch (cause) {
    if (cause instanceof ParseError) throw cause;
    throw toParseError(cause);
  }
}

/** Extract one page's text, mirroring unpdf's layout (EOL-aware str join). */
async function getPageText(pdf: PdfProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
    .map((item) => item.str + (item.hasEOL ? '\n' : ''))
    .join('');
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

/** Track a per-document running total; abort once the char budget is spent. */
function checkCharBudget(additional: string, runningTotal: number): number {
  const total = runningTotal + additional.length;
  if (total > PDF_PARSE_MAX_CHARS) {
    throw new ParseError(`PDF extracted text exceeds ${PDF_PARSE_MAX_CHARS} chars`);
  }
  return total;
}

export const unpdfParser: ContentParser = {
  async extractText(buffer: Buffer): Promise<string> {
    let pdf: PdfProxy | undefined;
    try {
      pdf = await openPdf(buffer);
      const pages: string[] = [];
      let totalChars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const pageText = await getPageText(pdf, i);
        totalChars = checkCharBudget(pageText, totalChars);
        pages.push(pageText);
      }
      return repairPdfSpacing(pages.join('\n').replace(/\s+/g, ' '));
    } catch (cause) {
      if (cause instanceof ParseError) throw cause;
      throw toParseError(cause);
    } finally {
      await pdf?.destroy();
    }
  },

  async extractPages(buffer: Buffer): Promise<Array<{ page: number; text: string }>> {
    let pdf: PdfProxy | undefined;
    try {
      pdf = await openPdf(buffer);
      const pages: Array<{ page: number; text: string }> = [];
      let totalChars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const pageText = repairPdfSpacing(await getPageText(pdf, i));
        totalChars = checkCharBudget(pageText, totalChars);
        pages.push({ page: i, text: pageText });
      }
      return pages;
    } catch (cause) {
      if (cause instanceof ParseError) throw cause;
      throw toParseError(cause);
    } finally {
      await pdf?.destroy();
    }
  },
};
