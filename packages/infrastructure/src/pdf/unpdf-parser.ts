import { getDocumentProxy } from 'unpdf';
import { ParseError } from '@app/domain';
import { PDF_PARSE_MAX_BYTES, PDF_PARSE_MAX_PAGES, PDF_PARSE_MAX_CHARS } from '@app/infrastructure/config';
import type { ContentParser } from '@app/domain';
import { registerContentParserProvider } from './registries';

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

function toParseError(cause: unknown): ParseError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ParseError(`Failed to parse PDF: ${msg}`, cause);
}

async function openPdf(buffer: Uint8Array): Promise<PdfProxy> {
  if (buffer.length > PDF_PARSE_MAX_BYTES) {
    throw new ParseError(`PDF is ${buffer.length} bytes (> ${PDF_PARSE_MAX_BYTES})`);
  }
  try {
    const pdf = await getDocumentProxy(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      {
        useSystemFonts: true,
        isEvalSupported: false,
        disableStream: true,
        disableAutoFetch: true,
        // Gate decoded-image budget (total pixels) on the input byte cap:
        // with a 4 bytes/pixel RGBA decode, pixmap memory stays ~<= input size.
        maxImageSize: Math.floor(PDF_PARSE_MAX_BYTES / 4),
      },
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

async function getPageText(pdf: PdfProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
    .map((item) => item.str + (item.hasEOL ? '\n' : ''))
    .join('');
  if (text.length > PDF_PARSE_MAX_CHARS) {
    throw new ParseError(`PDF page ${pageNumber} extracted text exceeds ${PDF_PARSE_MAX_CHARS} chars`);
  }
  return text;
}

// Re-join spaces unpdf inserts inside dotted tokens (versions, URLs, emails).
function repairPdfSpacing(text: string): string {
  let out = text;

  // Join "x. y" only when the char after the space is lowercase/digit, so real
  // sentence boundaries like "Inc. OmniBoard" are preserved.
  out = out.replace(/([A-Za-z0-9])\.\s+([a-z0-9])/g, '$1.$2');
  out = out.replace(/([A-Za-z0-9])-\s+([A-Za-z0-9])/g, '$1-$2');

  return out;
}

function checkCharBudget(additional: string, runningTotal: number): number {
  const total = runningTotal + additional.length;
  if (total > PDF_PARSE_MAX_CHARS) {
    throw new ParseError(`PDF extracted text exceeds ${PDF_PARSE_MAX_CHARS} chars`);
  }
  return total;
}

export const unpdfParser: ContentParser = {
  async extractText(buffer: Uint8Array): Promise<string> {
    let pdf: PdfProxy | undefined;
    try {
      pdf = await openPdf(buffer);
      if ((pdf as unknown as { isEncrypted?: boolean }).isEncrypted) {
        throw new ParseError('encrypted PDF');
      }
      if (pdf.numPages === 0) throw new ParseError('empty PDF');
      const pages: string[] = [];
      let totalChars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const pageText = await getPageText(pdf, i);
        totalChars = checkCharBudget(pageText, totalChars);
        pages.push(pageText);
      }
      const extractedText = repairPdfSpacing(pages.join('\n').replace(/\s+/g, ' '));
      if (extractedText.trim().length === 0) throw new ParseError('scanned PDF - no extractable text');
      return extractedText;
    } catch (cause) {
      if (cause instanceof ParseError) throw cause;
      throw toParseError(cause);
    } finally {
      await pdf?.destroy();
    }
  },

  async extractPages(buffer: Uint8Array): Promise<Array<{ page: number; text: string }>> {
    let pdf: PdfProxy | undefined;
    try {
      pdf = await openPdf(buffer);
      if ((pdf as unknown as { isEncrypted?: boolean }).isEncrypted) {
        throw new ParseError('encrypted PDF');
      }
      if (pdf.numPages === 0) throw new ParseError('empty PDF');
      const pages: Array<{ page: number; text: string }> = [];
      let totalChars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const pageText = repairPdfSpacing(await getPageText(pdf, i));
        totalChars = checkCharBudget(pageText, totalChars);
        pages.push({ page: i, text: pageText });
      }
      if (pages.length === 0 || pages.every((p) => p.text.trim().length === 0)) {
        throw new ParseError('scanned PDF - no extractable text');
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

registerContentParserProvider('unpdf', () => unpdfParser);
