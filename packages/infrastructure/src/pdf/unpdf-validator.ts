import { ParseError, type PdfValidator } from '@app/domain';
import { unpdfParser } from './unpdf-parser';
import { registerPdfValidatorProvider } from './registries';

function abortError(): ParseError {
  return new ParseError('PDF validation timed out');
}

export const unpdfValidator: PdfValidator = {
  async validate(buffer, opts): Promise<void> {
    if (buffer.length < 5 || new TextDecoder().decode(buffer.subarray(0, 5)) !== '%PDF-') {
      throw new ParseError('invalid PDF signature');
    }
    if (opts?.signal?.aborted) throw abortError();
    const validation = unpdfParser.extractPages(buffer);
    if (!opts?.signal) {
      await validation;
      return;
    }
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(abortError());
      opts.signal?.addEventListener('abort', abortHandler, { once: true });
    });
    try {
      await Promise.race([validation, aborted]);
    } finally {
      if (abortHandler) opts.signal.removeEventListener('abort', abortHandler);
    }
  },
};

registerPdfValidatorProvider('unpdf', () => unpdfValidator);
