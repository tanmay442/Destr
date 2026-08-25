import { describe, it, expect } from 'vitest';
import { appConfigSchema, type AppConfig } from '@app/domain';
import { shouldCache } from '../should-cache';
import type { EmittedCitation } from '../emit-citations';

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({ ...appConfigSchema.parse({}), ...overrides }) as AppConfig;

const citations: EmittedCitation[] = [
  {
    id: 1,
    documentId: 10,
    similarity: 0.9,
    snippet: 'snippet',
    fileName: null,
    page: null,
    sectionTitle: null,
    source: null,
  },
];

const baseInput = { blocked: false, isEmpty: false, ticketCreated: false };

describe('shouldCache', () => {
  it('caches a clean, cited, non-empty turn', () => {
    expect(shouldCache({ ...baseInput, citations, cfg: cfg() })).toBe(true);
  });

  it('refuses to cache without citations', () => {
    expect(
      shouldCache({ ...baseInput, citations: [], cfg: cfg() }),
    ).toBe(false);
  });

  it('refuses to cache a blocked answer', () => {
    expect(
      shouldCache({ ...baseInput, citations, blocked: true, cfg: cfg() }),
    ).toBe(false);
  });

  it('refuses to cache an empty-wall turn (isEmpty)', () => {
    expect(
      shouldCache({ ...baseInput, citations, isEmpty: true, cfg: cfg() }),
    ).toBe(false);
  });

  it('refuses to cache when a ticket was created', () => {
    expect(
      shouldCache({
        ...baseInput, citations, ticketCreated: true, cfg: cfg(),
      }),
    ).toBe(false);
  });

  it('refuses to cache when the hallucination check timed out', () => {
    expect(
      shouldCache({
        ...baseInput, citations, hallucinationTimedOut: true, cfg: cfg(),
      }),
    ).toBe(false);
  });

  it('refuses to cache when the hallucination check is disabled', () => {
    expect(
      shouldCache({
        ...baseInput,
        citations,
        cfg: cfg({ hallucinationCheckEnabled: false }),
      }),
    ).toBe(false);
  });
});
