import { describe, it, expect } from 'vitest';
import { computeChunkMetrics, formatMetricsRow, metricsTableHeader } from './chunk-metrics';

describe('computeChunkMetrics', () => {
  it('returns zeros for no chunks', () => {
    expect(computeChunkMetrics([])).toEqual({
      count: 0,
      meanChars: 0,
      p95Chars: 0,
      maxChars: 0,
      meanTokens: 0,
      p95Tokens: 0,
      overCapShare: 0,
      emptyShare: 0,
      duplicateShare: 0,
      sectionCoverage: 0,
    });
  });

  it('measures size distribution and section coverage', () => {
    const m = computeChunkMetrics(
      [
        { content: 'a'.repeat(100), sectionTitle: 'Intro' },
        { content: 'b'.repeat(200), sectionTitle: null },
        { content: 'c'.repeat(300), kind: 'parent' },
      ],
      { modelId: 'unknown-model', tokenCap: 250 },
    );
    expect(m.count).toBe(3);
    expect(m.meanChars).toBe(200);
    expect(m.maxChars).toBe(300);
    expect(m.meanTokens).toBe(200);
    expect(m.overCapShare).toBe(0.33);
    expect(m.emptyShare).toBe(0);
    expect(m.sectionCoverage).toBe(0.33);
  });

  it('counts empties and whitespace-variant duplicates', () => {
    const m = computeChunkMetrics([
      { content: 'Hello world' },
      { content: '  Hello   world ' },
      { content: '   ' },
    ]);
    expect(m.emptyShare).toBe(0.33);
    expect(m.duplicateShare).toBe(0.33);
  });
});

describe('metrics formatting', () => {
  it('renders one row per strategy under a shared header', () => {
    const m = computeChunkMetrics([{ content: 'Hello world', sectionTitle: 'S' }]);
    const row = formatMetricsRow('document-aware', m);
    expect(row).toContain('document-aware');
    expect(row).toContain('1');
    expect(metricsTableHeader()).toContain('strategy');
  });
});
