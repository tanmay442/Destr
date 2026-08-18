import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ getDocumentProxy: vi.fn() }));

vi.mock('unpdf', () => ({
  getDocumentProxy: mocks.getDocumentProxy,
}));

function makeProxy(numPages: number, texts: string[]) {
  return {
    numPages,
    getPage: vi.fn(async (n: number) => ({
      getTextContent: async () => ({
        items: Array.from(texts[n - 1] ?? '', (ch) => ({ str: ch, hasEOL: false })),
      }),
    })),
    destroy: vi.fn(async () => undefined),
  };
}

async function loadParser() {
  vi.resetModules();
  return import('./unpdf-parser');
}

describe('unpdfParser limits', () => {
  beforeEach(() => {
    vi.stubEnv('PDF_PARSE_MAX_CHARS', '100');
    vi.stubEnv('PDF_PARSE_MAX_PAGES', '3');
    vi.stubEnv('PDF_PARSE_MAX_BYTES', '1000000');
    mocks.getDocumentProxy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extracts pages sequentially and aborts when the running char budget is exceeded', async () => {
    const { unpdfParser } = await loadParser();
    const proxy = makeProxy(3, ['a'.repeat(60), 'b'.repeat(60), 'c']);
    mocks.getDocumentProxy.mockResolvedValue(proxy as never);
    await expect(unpdfParser.extractPages(Buffer.from('fake'))).rejects.toThrow(/exceeds/);
    expect(proxy.getPage).toHaveBeenCalledTimes(2);
  });

  it('returns pages in order when the budget holds', async () => {
    const { unpdfParser } = await loadParser();
    const proxy = makeProxy(3, ['alpha', 'beta', 'gamma']);
    mocks.getDocumentProxy.mockResolvedValue(proxy as never);
    const pages = await unpdfParser.extractPages(Buffer.from('fake'));
    expect(pages).toEqual([
      { page: 1, text: 'alpha' },
      { page: 2, text: 'beta' },
      { page: 3, text: 'gamma' },
    ]);
    expect(proxy.getPage).toHaveBeenCalledTimes(3);
  });

  it('rejects PDFs with more pages than the cap and destroys the proxy', async () => {
    const { unpdfParser } = await loadParser();
    const proxy = makeProxy(4, ['x'.repeat(10)]);
    mocks.getDocumentProxy.mockResolvedValue(proxy as never);
    await expect(unpdfParser.extractText(Buffer.from('fake'))).rejects.toThrow(/pages/);
    expect(proxy.destroy).toHaveBeenCalled();
  });

  it('rejects oversize PDFs before parsing', async () => {
    const { unpdfParser } = await loadParser();
    await expect(unpdfParser.extractPages(Buffer.alloc(1_000_001))).rejects.toThrow(/bytes/);
    expect(mocks.getDocumentProxy).not.toHaveBeenCalled();
  });

  it('rejects a single page whose extracted text exceeds the per-page cap', async () => {
    const { unpdfParser } = await loadParser();
    const proxy = makeProxy(1, ['z'.repeat(500)]);
    mocks.getDocumentProxy.mockResolvedValue(proxy as never);
    await expect(unpdfParser.extractText(Buffer.from('fake'))).rejects.toThrow(/exceeds/);
    expect(proxy.getPage).toHaveBeenCalledTimes(1);
  });

  it('passes hardened pdf.js options to getDocumentProxy', async () => {
    const { unpdfParser } = await loadParser();
    const proxy = makeProxy(1, ['ok']);
    mocks.getDocumentProxy.mockResolvedValue(proxy as never);
    await unpdfParser.extractPages(Buffer.from('fake'));
    const options = mocks.getDocumentProxy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).toMatchObject({
      useSystemFonts: true,
      isEvalSupported: false,
      disableStream: true,
      disableAutoFetch: true,
    });
    expect(options.maxImageSize).toBe(250_000);
  });
});
