import { describe, it, expect } from 'vitest';
import { createContentParser, createPdfValidator, registerContentParserProvider } from './registries';
import { unpdfParser } from './unpdf-parser';
import { unpdfValidator } from './unpdf-validator';

describe('pdf registries', () => {
  it('resolve unpdf by default', () => {
    expect(createContentParser()).toBe(unpdfParser);
    expect(createPdfValidator()).toBe(unpdfValidator);
  });

  it('swaps the parser with a one-line registration', () => {
    const fake = { extractPages: async () => [], extractText: async () => '' };
    registerContentParserProvider('unpdf', () => fake);
    try {
      expect(createContentParser()).toBe(fake);
    } finally {
      registerContentParserProvider('unpdf', () => unpdfParser);
    }
  });
});
