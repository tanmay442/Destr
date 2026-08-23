import { describe, it, expect } from 'vitest';
import { appConfigSchema, type AppConfig } from '@app/domain';
import { shouldCache } from '../should-cache';
import type { EmittedCitation } from '../emit-citations';
import type { AgenticResult } from '../../rag/agentic-search';

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({ ...appConfigSchema.parse({}), ...overrides }) as AppConfig;

const okAgentic = (): AgenticResult => ({
  chunks: [],
  rewrittenQuery: 'q',
  outOfDomain: false,
  isEmpty: false,
  degraded: false,
  fallbackReason: null,
  resultState: 'ok',
  gradingUnavailable: false,
});

const degradedAgentic = (fallbackReason: AgenticResult['fallbackReason']): AgenticResult => ({
  ...okAgentic(),
  degraded: true,
  fallbackReason,
  resultState: 'degraded',
});

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
    expect(shouldCache({ ...baseInput, citations, cfg: cfg(), agentic: okAgentic() })).toBe(true);
  });

  it('refuses to cache without citations', () => {
    expect(
      shouldCache({ ...baseInput, citations: [], cfg: cfg(), agentic: okAgentic() }),
    ).toBe(false);
  });

  it('refuses to cache a blocked answer', () => {
    expect(
      shouldCache({ ...baseInput, citations, blocked: true, cfg: cfg(), agentic: okAgentic() }),
    ).toBe(false);
  });

  it('refuses to cache an empty-wall turn (isEmpty)', () => {
    expect(
      shouldCache({ ...baseInput, citations, isEmpty: true, cfg: cfg(), agentic: okAgentic() }),
    ).toBe(false);
  });

  it('refuses to cache when a ticket was created', () => {
    expect(
      shouldCache({
        ...baseInput, citations, ticketCreated: true, cfg: cfg(), agentic: okAgentic(),
      }),
    ).toBe(false);
  });

  it.each([
    ['grader_unavailable', degradedAgentic('grader_unavailable')],
    ['all_filtered', degradedAgentic('all_filtered')],
    ['grading_disabled', degradedAgentic('grading_disabled')],
  ])('refuses to cache degraded turns (%s)', (_name, agentic) => {
    expect(shouldCache({ ...baseInput, citations, cfg: cfg(), agentic })).toBe(false);
  });

  it('refuses to cache when the hallucination check is disabled', () => {
    expect(
      shouldCache({
        ...baseInput,
        citations,
        cfg: cfg({ hallucinationCheckEnabled: false }),
        agentic: okAgentic(),
      }),
    ).toBe(false);
  });

  it('refuses to cache when chunk grading is disabled', () => {
    expect(
      shouldCache({
        ...baseInput,
        citations,
        cfg: cfg({ agenticChunkGradingEnabled: false }),
        agentic: okAgentic(),
      }),
    ).toBe(false);
  });
});
